/**
 * [INPUT]: 依赖 ./rpcFrameCodec 的编码/装配/计量、./relayTypes 的 RpcTransportPayload/身份匹配
 * [OUTPUT]: 对外提供 createAckRelayProtocol（字节级可靠通道适配器：send/onMessage + ACK/重放/流控/降级）、ByteProtocol 类型
 * [POS]: src/remote 的可靠传输层——pairingManager 把它架在 relayTransport（帧收发）与 localServer（消息字节）之间；
 *        移植自官方 @zcode/client acknowledged relay protocol（v3.15.1）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 语义（源码实证，含官方 Bugfix 注释的坑）：
 *   · 出向：消息字节 → 帧批次（admission：未确认总量 + 本批最坏字节 ≤ 重放缓冲 8MiB 才允许首片发出）
 *   · 入向：帧 → 装配 → 消息字节 → 上抛；每条完整消息记 pending ACK（只保留最大 messageSeq），随下次 flush 合并发出
 *   · 重放：连接恢复（onSendReady）时 resetReplay 重发全部未确认帧；对端按 messageSeq 去重
 *   · deadline：最老未确认数据/未发 ACK 超过 45s 宽限 → 降级（terminal fault，bridge 报废等重建）
 *   · 流控：未确认 > 1MiB 饱和（回调 onSaturated）、< 256KiB 恢复（onDrained）——上层据此对 server 背压
 *   · 发送回调内入栈重入防护（outboundCallDepth）与 queuedInbound 缓冲
 */
import {
  encodeRpcFrames,
  measureRelayEnvelopeBytes,
  RpcFrameEncodingError,
  RpcTransportAssembler,
  type RpcFrameFault,
} from './rpcFrameCodec';
import {
  isRawTransportCandidate,
  rawIdentityMatches,
  RPC_TRANSPORT_LIMITS,
  type RelayBridgeIdentity,
  type RpcTransportFramePayload,
  type RpcTransportPayload,
} from './relayTypes';

export const ACK_RELAY_LIMITS = {
  saturationHighWaterMarkBytes: 1024 * 1024,
  saturationLowWaterMarkBytes: 256 * 1024,
  replayBufferMaxBytes: 8 * 1024 * 1024,
  replayBufferGraceMs: 45_000,
} as const;

export interface ByteProtocol {
  send(bytes: Uint8Array): void;
  onMessage(listener: (bytes: Uint8Array) => void): { dispose(): void };
  drain?(): Promise<void>;
}

export interface AckRelayProtocolOptions extends RelayBridgeIdentity {
  sendFrame(payload: RpcTransportPayload): boolean | void;
  measureFrameBytes?(payload: RpcTransportFramePayload): number;
  now?: () => number;
}

export interface AckRelayProtocol {
  readonly protocol: ByteProtocol;
  readonly onDegraded: (listener: (fault: RpcFrameFault) => void) => { dispose(): void };
  readonly onSaturated: (listener: () => void) => { dispose(): void };
  readonly onDrained: (listener: () => void) => { dispose(): void };
  acceptPayload(payload: unknown): boolean;
  flushPendingFrames(): boolean;
  replayUnacknowledged(): boolean;
  getBridgeSessionId(): string;
  isDegraded(): boolean;
  markDegraded(reasonCode?: string): void;
  dispose(): void;
}

interface OutboundBatch {
  readonly messageSeq: number;
  readonly frames: readonly RpcTransportFramePayload[];
  readonly outerBytes: number;
  readonly queuedAt: number;
  nextFrameIndex: number;
}

// ═══════════════ 出向批队列（head 推进 + 阈值 compact，均摊 O(1)） ═══════════════

class BatchQueue {
  private storage: Array<OutboundBatch | undefined> = [];
  private headIndex = 0;
  private nextUnsentIndex = 0;

  get oldest(): OutboundBatch | undefined {
    return this.storage[this.headIndex];
  }

  get nextUnsent(): OutboundBatch | undefined {
    return this.storage[this.nextUnsentIndex];
  }

  append(batch: OutboundBatch): void {
    this.storage.push(batch);
  }

  advanceUnsent(): void {
    if (this.nextUnsentIndex < this.storage.length) this.nextUnsentIndex += 1;
  }

  resetReplay(): void {
    for (let index = this.headIndex; index < this.storage.length; index += 1) {
      const batch = this.storage[index];
      if (batch) batch.nextFrameIndex = 0;
    }
    this.nextUnsentIndex = this.headIndex;
  }

  releaseThrough(ackMessageSeq: number): number {
    let releasedBytes = 0;
    while (this.headIndex < this.storage.length) {
      const batch = this.storage[this.headIndex]!;
      if (batch.messageSeq > ackMessageSeq) break;
      releasedBytes += batch.outerBytes;
      this.storage[this.headIndex] = undefined;
      this.headIndex += 1;
    }
    this.nextUnsentIndex = Math.max(this.nextUnsentIndex, this.headIndex);
    if (this.headIndex >= 1_024 && this.headIndex * 2 >= this.storage.length) {
      this.storage = this.storage.slice(this.headIndex);
      this.nextUnsentIndex = Math.max(0, this.nextUnsentIndex - this.headIndex);
      this.headIndex = 0;
    }
    return releasedBytes;
  }

  clear(): void {
    this.storage = [];
    this.headIndex = 0;
    this.nextUnsentIndex = 0;
  }
}

// ═══════════════ deadline（最老未确认/未发 ACK 的宽限计时） ═══════════════

class AckDeadline {
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private readonly graceMs: number,
    private readonly now: () => number,
    private readonly readState: () => { oldestData: { queuedAt: number; messageSeq: number } | null; pendingAck: { queuedAt: number; messageSeq: number } | null },
    private readonly onExpired: (fault: RpcFrameFault) => void,
  ) {}

  check(): boolean {
    if (this.disposed) return false;
    const selected = this.select();
    if (!selected || this.now() < selected.deadline) return false;
    this.onExpired(selected.fault);
    return true;
  }

  refresh(): void {
    if (this.disposed) return;
    this.clear();
    const selected = this.select();
    if (!selected) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.check()) this.refresh();
    }, Math.max(0, selected.deadline - this.now()));
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private select(): { deadline: number; fault: RpcFrameFault } | null {
    const state = this.readState();
    const data = state.oldestData;
    const ack = state.pendingAck;
    if (!data && !ack) return null;
    if (ack && (!data || ack.queuedAt <= data.queuedAt)) {
      return { deadline: ack.queuedAt + this.graceMs + 1, fault: { reasonCode: 'remote.rpcFrame.ackGraceExceeded', terminal: true, messageSeq: ack.messageSeq } };
    }
    return { deadline: data!.queuedAt + this.graceMs + 1, fault: { reasonCode: 'remote.rpcFrame.replayGraceExceeded', terminal: true, messageSeq: data!.messageSeq } };
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

// ═══════════════ 协议主体 ═══════════════

class AckRelayProtocolImpl implements AckRelayProtocol {
  private readonly identity: RelayBridgeIdentity;
  private readonly sendFrame: AckRelayProtocolOptions['sendFrame'];
  private readonly measureFrameBytes: (payload: RpcTransportFramePayload) => number;
  private readonly now: () => number;
  private readonly deadline: AckDeadline;
  private readonly messageListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly degradedListeners = new Set<(fault: RpcFrameFault) => void>();
  private readonly saturatedListeners = new Set<() => void>();
  private readonly drainedListeners = new Set<() => void>();
  private assembler: RpcTransportAssembler | null;
  private readonly outboundBatches = new BatchQueue();
  private queuedInbound: unknown[] = [];
  private pendingAckMessageSeq: number | null = null;
  private pendingAckQueuedAt: number | null = null;
  private nextPhysicalSeq = 1;
  private nextMessageSeq = 1;
  private highestFullySentMessageSeq = 0;
  private lastAckedMessageSeq = 0;
  private unacknowledgedByteCount = 0;
  private saturated = false;
  private disposed = false;
  private degraded = false;
  private flushing = false;
  private outboundCallDepth = 0;
  private assemblyTimer?: ReturnType<typeof setTimeout>;

  readonly protocol: ByteProtocol = {
    onMessage: (listener) => {
      this.messageListeners.add(listener);
      return { dispose: () => this.messageListeners.delete(listener) };
    },
    send: (bytes) => this.reserveMessage(bytes),
  };

  constructor(options: AckRelayProtocolOptions) {
    this.identity = {
      bridgeSessionId: options.bridgeSessionId,
      ...(options.bridgeGeneration === undefined ? {} : { bridgeGeneration: options.bridgeGeneration }),
      ...(options.recoveryId === undefined ? {} : { recoveryId: options.recoveryId }),
    };
    this.sendFrame = options.sendFrame;
    this.measureFrameBytes = options.measureFrameBytes ?? ((frame) => measureRelayEnvelopeBytes(frame));
    this.now = options.now ?? Date.now;
    this.deadline = new AckDeadline(
      ACK_RELAY_LIMITS.replayBufferGraceMs,
      this.now,
      () => ({
        oldestData: this.outboundBatches.oldest
          ? { queuedAt: this.outboundBatches.oldest.queuedAt, messageSeq: this.outboundBatches.oldest.messageSeq }
          : null,
        pendingAck:
          this.pendingAckQueuedAt === null || this.pendingAckMessageSeq === null
            ? null
            : { queuedAt: this.pendingAckQueuedAt, messageSeq: this.pendingAckMessageSeq },
      }),
      (fault) => this.enterDegraded(fault),
    );
    this.assembler = new RpcTransportAssembler({ ...this.identity, timeoutMs: RPC_TRANSPORT_LIMITS.assemblyTimeoutMs, now: this.now });
  }

  getBridgeSessionId(): string {
    return this.identity.bridgeSessionId;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  markDegraded(reasonCode = 'remote.rpcFrame.manuallyDegraded'): void {
    this.enterDegraded({ reasonCode, terminal: true });
  }

  readonly onDegraded = (listener: (fault: RpcFrameFault) => void) => {
    this.degradedListeners.add(listener);
    return { dispose: () => this.degradedListeners.delete(listener) };
  };

  readonly onSaturated = (listener: () => void) => {
    this.saturatedListeners.add(listener);
    return { dispose: () => this.saturatedListeners.delete(listener) };
  };

  readonly onDrained = (listener: () => void) => {
    this.drainedListeners.add(listener);
    return { dispose: () => this.drainedListeners.delete(listener) };
  };

  // ---------- 出向 ----------

  private reserveMessage(bytes: Uint8Array): void {
    if (this.disposed || this.degraded || this.deadline.check()) return;
    let frames: readonly RpcTransportFramePayload[];
    try {
      frames = encodeRpcFrames(bytes, { ...this.identity, firstPhysicalSeq: this.nextPhysicalSeq, messageSeq: this.nextMessageSeq });
    } catch (error) {
      this.enterDegraded({
        reasonCode: error instanceof RpcFrameEncodingError ? error.reasonCode : 'remote.rpcFrame.encodingFailed',
        terminal: true,
      });
      return;
    }
    let outerBytes = 0;
    try {
      outerBytes = frames.reduce((total, frame) => total + this.measureFrameBytes(frame), 0);
    } catch {
      this.enterDegraded({ reasonCode: 'remote.rpcFrame.outerMeterFailed', terminal: true });
      return;
    }
    if (this.unacknowledgedByteCount + outerBytes > ACK_RELAY_LIMITS.replayBufferMaxBytes) {
      // 必须在首片发出前对整批最坏字节做 admission，不能给对端留下半条 RPC
      this.enterDegraded({ reasonCode: 'remote.rpcFrame.replayBufferExceeded', terminal: true, messageSeq: this.nextMessageSeq });
      return;
    }
    const messageSeq = this.nextMessageSeq;
    const lastFrame = frames.at(-1)!;
    this.outboundBatches.append({ messageSeq, frames, outerBytes, queuedAt: this.now(), nextFrameIndex: 0 });
    this.unacknowledgedByteCount += outerBytes;
    this.nextMessageSeq += 1;
    this.nextPhysicalSeq = lastFrame.seq + 1;
    if (!this.saturated && this.unacknowledgedByteCount > ACK_RELAY_LIMITS.saturationHighWaterMarkBytes) {
      this.saturated = true;
      for (const listener of this.saturatedListeners) listener();
    }
    this.deadline.refresh();
    this.flushPendingFrames();
  }

  private invokeSend(payload: RpcTransportPayload): boolean {
    this.outboundCallDepth += 1;
    try {
      return this.sendFrame(payload) !== false;
    } catch {
      this.enterDegraded({ reasonCode: 'remote.rpcFrame.sendFailed', terminal: true });
      return false;
    } finally {
      this.outboundCallDepth -= 1;
    }
  }

  flushPendingFrames(): boolean {
    if (this.disposed || this.degraded || this.deadline.check()) return false;
    if (this.flushing) return false;
    this.flushing = true;
    let locallyDrained = true;
    try {
      while (!this.disposed && !this.degraded) {
        if (this.deadline.check()) {
          locallyDrained = false;
          break;
        }
        if (this.pendingAckMessageSeq !== null) {
          const ackMessageSeq = this.pendingAckMessageSeq;
          const accepted = this.invokeSend({ zcode_type: 'rpc-frame-ack', ...this.identity, ackMessageSeq });
          if (!accepted || this.degraded || this.disposed) {
            locallyDrained = false;
            break;
          }
          if (this.pendingAckMessageSeq === ackMessageSeq) {
            this.pendingAckMessageSeq = null;
            this.pendingAckQueuedAt = null;
            this.deadline.refresh();
          }
          this.drainQueuedInbound();
          continue;
        }
        const batch = this.outboundBatches.nextUnsent;
        if (!batch) break;
        const frame = batch.frames[batch.nextFrameIndex]!;
        const accepted = this.invokeSend(frame);
        if (!accepted || this.degraded || this.disposed) {
          locallyDrained = false;
          break;
        }
        batch.nextFrameIndex += 1;
        if (batch.nextFrameIndex === batch.frames.length) {
          this.highestFullySentMessageSeq = Math.max(this.highestFullySentMessageSeq, batch.messageSeq);
          this.outboundBatches.advanceUnsent();
        }
        this.drainQueuedInbound();
      }
    } finally {
      this.flushing = false;
    }
    if (!this.disposed && !this.degraded) this.drainQueuedInbound();
    return locallyDrained && this.pendingAckMessageSeq === null;
  }

  replayUnacknowledged(): boolean {
    if (this.disposed || this.degraded || this.deadline.check()) return false;
    this.outboundBatches.resetReplay();
    return this.flushPendingFrames();
  }

  // ---------- 入向 ----------

  acceptPayload(payload: unknown): boolean {
    if (this.disposed || this.degraded || !isRawTransportCandidate(payload)) return false;
    if (!rawIdentityMatches(this.identity, payload)) return false;
    if (this.deadline.check()) return true;
    if (this.outboundCallDepth > 0) {
      this.queuedInbound.push(payload);
      return true;
    }
    this.processInbound(payload);
    return true;
  }

  private drainQueuedInbound(): void {
    if (this.outboundCallDepth > 0 || this.disposed || this.degraded) return;
    while (this.queuedInbound.length > 0 && !this.disposed && !this.degraded) {
      this.processInbound(this.queuedInbound.shift());
    }
  }

  private processInbound(candidate: unknown): void {
    const value = candidate as Record<string, unknown>;
    if (value?.zcode_type === 'rpc-frame-ack') {
      this.processAck(value.ackMessageSeq as number);
      return;
    }
    const result = this.assembler?.accept(candidate, this.now());
    if (!result) return;
    if (result.kind === 'fault') {
      if (result.fault.terminal) this.enterDegraded(result.fault);
      return;
    }
    if (result.kind === 'incomplete') {
      this.scheduleAssemblyTimer();
      return;
    }
    if (result.kind === 'duplicate') {
      if (result.ackMessageSeq !== null) this.queueAck(result.ackMessageSeq);
      return;
    }
    this.clearAssemblyTimer();
    for (const listener of this.messageListeners) {
      try {
        listener(result.bytes);
      } catch {
        this.enterDegraded({ reasonCode: 'remote.rpcFrame.deliveryFailed', terminal: true, messageSeq: result.messageSeq });
        return;
      }
    }
    this.queueAck(result.messageSeq);
  }

  private queueAck(messageSeq: number): void {
    if (this.disposed || this.degraded) return;
    if (this.pendingAckMessageSeq === null) {
      this.pendingAckMessageSeq = messageSeq;
      this.pendingAckQueuedAt = this.now();
      this.deadline.refresh();
    } else if (messageSeq > this.pendingAckMessageSeq) {
      this.pendingAckMessageSeq = messageSeq;
    }
    this.flushPendingFrames();
  }

  private processAck(ackMessageSeq: number): void {
    if (ackMessageSeq <= this.lastAckedMessageSeq) return;
    if (ackMessageSeq > this.highestFullySentMessageSeq) {
      this.enterDegraded({ reasonCode: 'remote.rpcFrame.futureAck', terminal: true, messageSeq: ackMessageSeq });
      return;
    }
    const releasedBytes = this.outboundBatches.releaseThrough(ackMessageSeq);
    this.unacknowledgedByteCount = Math.max(0, this.unacknowledgedByteCount - releasedBytes);
    this.lastAckedMessageSeq = ackMessageSeq;
    this.deadline.refresh();
    if (this.saturated && this.unacknowledgedByteCount <= ACK_RELAY_LIMITS.saturationLowWaterMarkBytes) {
      this.saturated = false;
      for (const listener of this.drainedListeners) listener();
    }
  }

  private scheduleAssemblyTimer(): void {
    if (this.assemblyTimer || !this.assembler?.nextExpiryAt) return;
    const deadline = this.assembler.nextExpiryAt;
    this.assemblyTimer = setTimeout(() => {
      this.assemblyTimer = undefined;
      const result = this.assembler?.expire(this.now());
      if (result?.kind === 'fault') this.enterDegraded(result.fault);
    }, Math.max(0, deadline - this.now()));
    this.assemblyTimer.unref?.();
  }

  private clearAssemblyTimer(): void {
    if (this.assemblyTimer) clearTimeout(this.assemblyTimer);
    this.assemblyTimer = undefined;
  }

  private enterDegraded(fault: RpcFrameFault): void {
    if (this.disposed || this.degraded) return;
    this.degraded = true;
    this.deadline.dispose();
    this.clearAssemblyTimer();
    this.outboundBatches.clear();
    this.queuedInbound = [];
    this.pendingAckMessageSeq = null;
    this.pendingAckQueuedAt = null;
    this.unacknowledgedByteCount = 0;
    this.saturated = false;
    this.assembler = null;
    for (const listener of this.degradedListeners) listener(fault);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deadline.dispose();
    this.clearAssemblyTimer();
    this.outboundBatches.clear();
    this.queuedInbound = [];
    this.pendingAckMessageSeq = null;
    this.pendingAckQueuedAt = null;
    this.unacknowledgedByteCount = 0;
    this.assembler = null;
    this.messageListeners.clear();
    this.degradedListeners.clear();
    this.saturatedListeners.clear();
    this.drainedListeners.clear();
  }
}

export function createAckRelayProtocol(options: AckRelayProtocolOptions): AckRelayProtocol {
  return new AckRelayProtocolImpl(options);
}
