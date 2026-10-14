/**
 * [INPUT]: 依赖 ws 的 WebSocket 客户端、./relayTypes 的线消息/载荷/常量、./relayAuth 的 proof 计算
 * [OUTPUT]: 对外提供 RelayTransport（设备角色状态机：注册→挑战应答→配对→心跳→重连）、
 *           RelayTransportState、RelaySendResult、RelayTransportOptions
 * [POS]: src/remote 的传输层——pairingManager 消费；移植自桌面 webRemoteControlTransport（v3.15.1），去除埋点与消息追踪
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 状态机（源码实证，含官方 Bugfix 语义）：
 *   idle → connecting → registering|authenticating → waiting_terminal ⇄ paired
 *   · 首连 register：device_register_init → ack 得 sid → 切 persisted → auth_init（重连不再 register，避免旧二维码失效）
 *   · auth_challenge → auth_response{proof}
 *   · 心跳 pair_status_query（10s ± 2s jitter）；ACK watchdog 30s；已配对后收到 waiting 先进入
 *     「怀疑态」（15s 恢复窗），二次 waiting 或超时才强制重连——防 relay 抖动误杀手机连接
 *   · KICKED=新 terminal 顶替：重连而非终止；AUTH_FAILED(persisted) 一次性降级为 register 重试
 *   · INTERNAL 于 paired/waiting：回 waiting_terminal 继续保活（对端暂时不在不升级为断开）
 *   · 发送门：paired 且非怀疑态；超 1MiB 物理帧直接 oversize 拒绝
 */
import { WebSocket, type RawData } from 'ws';
import {
  getHeartbeatDelayMs,
  getReconnectJitterMs,
  HEARTBEAT_ACK_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_JITTER_MS,
  isRawTransportCandidate,
  parseRelayAppPayload,
  parseRelayMessage,
  RPC_TRANSPORT_LIMITS,
  STALE_WAITING_RECOVERY_MS,
  type RelayAppPayload,
  type RelayDeviceMeta,
  type RelayIncomingMessage,
  type RelayOutgoingMessage,
} from './relayTypes';
import { calculateRelayProof, type RelayDeviceAuth } from './relayAuth';

export type RelayTransportState =
  | 'idle'
  | 'connecting'
  | 'registering'
  | 'authenticating'
  | 'waiting_terminal'
  | 'paired'
  | 'error';

export type RelaySendResult =
  | { kind: 'sent'; bytes: number }
  | { kind: 'unavailable' }
  | { kind: 'oversize'; bytes: number; maxBytes: number };

export interface RelayTransportOptions {
  relayWsUrl: string;
  deviceMid: string;
  auth: RelayDeviceAuth;
  meta: RelayDeviceMeta;
  logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  heartbeatIntervalMs?: number;
  heartbeatJitterMs?: number;
  heartbeatAckTimeoutMs?: number;
  reconnectDelayMs?: number;
  /** 联调用：不发送 X-Device-ID 头（与浏览器终端的路由特征对齐），生产恒为 true */
  sendDeviceIdHeader?: boolean;
  onRegisteredAuth(auth: { deviceSid: string; passHash: string }): void;
  onStateChange(state: RelayTransportState): void;
  onPayload(payload: RelayAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onError(error: Error): void;
  onSendReady?(event: { kind: 'same-socket' | 'reconnected-socket' }): void;
  onInvalidPersistedAuth(): Promise<void>;
}

interface PreparedPayload {
  readonly message: RelayOutgoingMessage;
  readonly json: string;
  readonly bytes: number;
}

/** 同一 payload 固定唯一最终 JSON（计量与实际写入一致；WeakMap 生命周期跟随 payload 对象） */
class PayloadSerializer {
  private readonly cache = new WeakMap<object, PreparedPayload>();

  prepare(payload: RelayAppPayload): PreparedPayload {
    const cached = this.cache.get(payload);
    if (cached) return cached;
    const message: RelayOutgoingMessage = { type: 'data', payload, client_ts: Date.now() };
    const json = JSON.stringify(message);
    const prepared = Object.freeze({ message, json, bytes: Buffer.byteLength(json, 'utf8') });
    this.cache.set(payload, prepared);
    return prepared;
  }
}

function estimateRawBytes(raw: RawData): number {
  if (Array.isArray(raw)) return raw.reduce((total, part) => total + part.byteLength, 0);
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return Buffer.byteLength(String(raw), 'utf8');
}

export class RelayTransport {
  private socket?: WebSocket;
  private state: RelayTransportState = 'idle';
  private activeAuth: RelayDeviceAuth;
  private deviceSid?: string;
  private manuallyClosed = false;
  private terminalClose = false;
  private invalidPersistedRetryUsed = false;
  private suppressNextCloseReconnect = false;
  private wasPaired = false;
  private staleWaitingCount = 0;
  private lastPairStatusAckAt = 0;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private heartbeatAckWatchdogTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private staleWaitingRecoveryTimer?: ReturnType<typeof setTimeout>;
  private socketGeneration = 0;
  private lastPairedSocketGeneration = 0;
  /** 滚动 60s 内的重连次数（互踢风暴探测：同设备身份被多处在线时连接被反复断开） */
  private reconnectTimes: number[] = [];
  private stormNotified = false;
  private readonly serializer = new PayloadSerializer();

  constructor(private readonly options: RelayTransportOptions) {
    this.activeAuth = options.auth;
    this.deviceSid = options.auth.mode === 'persisted' ? options.auth.deviceSid : undefined;
  }

  start(): void {
    this.manuallyClosed = false;
    this.terminalClose = false;
    this.wasPaired = false;
    this.lastPairedSocketGeneration = 0;
    this.staleWaitingCount = 0;
    this.lastPairStatusAckAt = 0;
    this.reconnectTimes = [];
    this.stormNotified = false;
    this.connect();
  }

  measurePayloadBytes(payload: RelayAppPayload): number {
    return this.serializer.prepare(payload).bytes;
  }

  sendPayload(payload: RelayAppPayload): boolean {
    return this.sendPayloadResult(payload).kind === 'sent';
  }

  sendPayloadResult(payload: RelayAppPayload): RelaySendResult {
    const prepared = this.serializer.prepare(payload);
    if (prepared.bytes > RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return { kind: 'oversize', bytes: prepared.bytes, maxBytes: RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes };
    }
    if (this.state !== 'paired' || this.staleWaitingCount > 0) {
      return { kind: 'unavailable' };
    }
    return this.sendSerialized(prepared.message, prepared.json) ? { kind: 'sent', bytes: prepared.bytes } : { kind: 'unavailable' };
  }

  dispose(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearStaleWaitingRecoveryTimer();
    this.socket?.close();
    this.socket = undefined;
    this.setState('idle');
  }

  // ═══════════════ 连接与握手 ═══════════════

  private connect(): void {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearStaleWaitingRecoveryTimer();
    this.socketGeneration += 1;
    this.setState('connecting');
    this.lastPairStatusAckAt = Date.now();

    // relay 边缘层按 query.mid 分片路由；单独依赖 X-Device-ID 会两端落到不同后端
    const relayUrl = new URL(this.options.relayWsUrl);
    relayUrl.searchParams.set('mid', this.options.deviceMid);

    const socket = new WebSocket(relayUrl.toString(), {
      perMessageDeflate: true,
      ...(this.options.sendDeviceIdHeader === false ? {} : { headers: { 'X-Device-ID': this.options.deviceMid } }),
    });
    this.socket = socket;

    socket.on('open', () => {
      if (socket !== this.socket) return;
      if (this.activeAuth.mode === 'register') {
        this.setState('registering');
        this.send({
          type: 'device_register_init',
          device_mid: this.options.deviceMid,
          pass_hash: this.activeAuth.passHash,
          meta: this.options.meta,
          client_ts: Date.now(),
        });
        return;
      }
      this.sendAuthInit(this.activeAuth.deviceSid);
    });

    socket.on('message', (raw) => {
      if (socket !== this.socket) return;
      if (estimateRawBytes(raw) > RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
        this.options.logger?.warn('[relay] oversize message dropped', { bytes: estimateRawBytes(raw) });
        this.options.onRawTransportFault?.('remote.rpcFrame.envelopeTooLarge');
        return;
      }
      const rawText =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : Buffer.isBuffer(raw)
              ? raw.toString('utf8')
              : Buffer.from(raw).toString('utf8');
      const message = parseRelayMessage(rawText);
      if (!message) {
        this.options.logger?.warn('[relay] invalid message dropped');
        return;
      }
      void this.handleMessage(message);
    });

    socket.on('error', (error) => {
      if (socket !== this.socket) return;
      this.options.logger?.warn('[relay] socket error', { message: error.message });
      this.options.onError(error);
    });

    socket.on('close', () => {
      if (socket !== this.socket) return;
      this.stopHeartbeat();
      if (this.suppressNextCloseReconnect) {
        this.suppressNextCloseReconnect = false;
        return;
      }
      if (!this.manuallyClosed && !this.terminalClose) {
        this.options.logger?.warn('[relay] disconnected, reconnecting');
        this.noteReconnectStorm();
        this.scheduleReconnect();
      }
    });
  }

  private async handleMessage(message: RelayIncomingMessage): Promise<void> {
    switch (message.type) {
      case 'device_register_ack': {
        this.deviceSid = message.device_sid;
        if (this.activeAuth.mode === 'register') {
          this.options.onRegisteredAuth({ deviceSid: message.device_sid, passHash: this.activeAuth.passHash });
          // 首次注册后重连必须走 persisted auth_init，避免旧二维码里的 sid 失效
          this.activeAuth = { mode: 'persisted', deviceSid: message.device_sid, passHash: this.activeAuth.passHash };
        }
        this.sendAuthInit(message.device_sid);
        break;
      }
      case 'auth_challenge': {
        if (!this.deviceSid) {
          this.enterError(new Error('auth challenge arrived before device_sid'));
          return;
        }
        this.send({
          type: 'auth_response',
          device_sid: this.deviceSid,
          proof: calculateRelayProof(this.activeAuth.passHash, message.nonce, 'device', this.deviceSid),
          client_ts: Date.now(),
        });
        break;
      }
      case 'auth_ack':
      case 'pair_status_ack': {
        this.applyPairStatus(message.pair_status);
        break;
      }
      case 'data': {
        this.handleDataPayload(message.payload);
        break;
      }
      case 'error': {
        await this.handleRelayError(message.code, message.message);
        break;
      }
    }
  }

  private noteReconnectStorm(): void {
    const now = Date.now();
    this.reconnectTimes = this.reconnectTimes.filter((t) => now - t < 60_000);
    this.reconnectTimes.push(now);
    if (this.reconnectTimes.length >= 5 && !this.stormNotified) {
      this.stormNotified = true;
      // 与桌面端远控/其他 VSCode 窗口共用同一设备身份时的互踢战争——上报一次可行动提示
      this.options.onError(
        new Error('relay 连接被反复断开（60 秒内 5 次以上）：同一设备身份同时只能一端在线。请检查桌面端 ZCode 的手机远控是否开着，或关闭其他 VSCode 窗口的配对。'),
      );
    }
  }

  private sendAuthInit(deviceSid: string): void {
    this.deviceSid = deviceSid;
    this.setState('authenticating');
    this.send({ type: 'auth_init', role: 'device', device_sid: deviceSid, meta: this.options.meta, client_ts: Date.now() });
  }

  // ═══════════════ 配对状态 ═══════════════

  private applyPairStatus(status: 'waiting' | 'matched'): void {
    this.lastPairStatusAckAt = Date.now();
    this.armHeartbeatAckWatchdog();
    if (status === 'waiting') {
      if (this.wasPaired) {
        // 已配对会话的偶发 waiting：先进怀疑态暂停业务发送，二次 waiting 或 15s 未恢复才重连
        this.staleWaitingCount += 1;
        this.startHeartbeat();
        if (this.staleWaitingCount === 1) {
          this.scheduleStaleWaitingRecovery();
          return;
        }
        this.reconnectAfterStaleWaiting();
        return;
      }
      // 等待扫码阶段持续心跳保活，防 relay 空闲回收
      this.setState('waiting_terminal');
      this.startHeartbeat();
      return;
    }
    // matched
    const previousPairedGeneration = this.lastPairedSocketGeneration;
    const sendReadyKind =
      previousPairedGeneration === 0
        ? null
        : previousPairedGeneration === this.socketGeneration
          ? ('same-socket' as const)
          : ('reconnected-socket' as const);
    this.staleWaitingCount = 0;
    this.clearStaleWaitingRecoveryTimer();
    this.setState('paired');
    this.wasPaired = true;
    this.lastPairedSocketGeneration = this.socketGeneration;
    this.startHeartbeat();
    if (sendReadyKind) this.options.onSendReady?.({ kind: sendReadyKind });
  }

  private async handleRelayError(code: string, message: string): Promise<void> {
    if (code === 'KICKED') {
      // 同一远控链接只允许一个 terminal；心跳超时重建 socket 也可能短暂收到，重连而非终止
      this.options.logger?.warn('[relay] KICKED, reconnecting', { message });
      this.socket?.close();
      return;
    }
    if (code === 'AUTH_FAILED' && this.activeAuth.mode === 'persisted' && !this.invalidPersistedRetryUsed) {
      this.invalidPersistedRetryUsed = true;
      await this.options.onInvalidPersistedAuth();
      this.activeAuth = { mode: 'register', passHash: this.activeAuth.passHash };
      this.deviceSid = undefined;
      this.suppressNextCloseReconnect = true;
      this.socket?.close();
      this.scheduleReconnect(0);
      return;
    }
    if (code === 'INTERNAL') {
      if (this.state === 'paired' || this.state === 'waiting_terminal') {
        // 对端（手机）暂时不在：不升级为断开，回等待态继续保活
        this.options.onError(new Error(message || code));
        this.clearStaleWaitingRecoveryTimer();
        this.staleWaitingCount = 0;
        this.wasPaired = false;
        this.startHeartbeat();
        this.setState('waiting_terminal');
        return;
      }
      this.enterRecoverableError(new Error(message || code));
      return;
    }
    if (code === 'WRONG_PARAM' && (this.state === 'paired' || this.state === 'waiting_terminal')) {
      this.options.onError(new Error(message || code));
      return;
    }
    this.enterError(new Error(message || code));
  }

  private handleDataPayload(payload: unknown): void {
    if (this.state !== 'paired') return;
    if (isRawTransportCandidate(payload) && this.options.onRawTransportPayload?.(payload)) return;
    const parsed = parseRelayAppPayload(payload);
    if (!parsed) {
      this.options.logger?.warn('[relay] invalid app payload dropped');
      return;
    }
    this.options.onPayload(parsed);
  }

  // ═══════════════ 心跳与重连 ═══════════════

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.armHeartbeatAckWatchdog();
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setTimeout(
      () => {
        this.heartbeatTimer = undefined;
        if (!this.deviceSid || (this.state !== 'paired' && this.state !== 'waiting_terminal')) return;
        this.send({ type: 'pair_status_query', device_sid: this.deviceSid, client_ts: Date.now() });
        // 每次发送后重新抽样 jitter，只打散相位不改变平均周期
        this.scheduleHeartbeat();
      },
      getHeartbeatDelayMs(
        Math.min(this.options.heartbeatJitterMs ?? HEARTBEAT_JITTER_MS, (this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS) - 1),
      ),
    );
    this.heartbeatTimer.unref?.();
  }

  private armHeartbeatAckWatchdog(): void {
    if (this.state !== 'paired' && this.state !== 'waiting_terminal') return;
    if (this.heartbeatAckWatchdogTimer) clearTimeout(this.heartbeatAckWatchdogTimer);
    // ACK deadline 独立于下一次 jittered 心跳，避免随机间隔把 30s 失联判定漂移
    this.heartbeatAckWatchdogTimer = setTimeout(() => {
      this.heartbeatAckWatchdogTimer = undefined;
      if (this.state !== 'paired' && this.state !== 'waiting_terminal') return;
      this.options.logger?.warn('[relay] heartbeat ack timeout, reconnecting', { state: this.state, staleMs: Date.now() - this.lastPairStatusAckAt });
      this.reconnectAfterStaleWaiting(getReconnectJitterMs());
    }, this.options.heartbeatAckTimeoutMs ?? HEARTBEAT_ACK_TIMEOUT_MS);
    this.heartbeatAckWatchdogTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.heartbeatAckWatchdogTimer) {
      clearTimeout(this.heartbeatAckWatchdogTimer);
      this.heartbeatAckWatchdogTimer = undefined;
    }
  }

  private scheduleReconnect(delayMs = this.options.reconnectDelayMs ?? 1_000): void {
    if (this.manuallyClosed || this.terminalClose) return;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private scheduleStaleWaitingRecovery(): void {
    if (this.staleWaitingRecoveryTimer) return;
    // 15s 至少覆盖一轮心跳（10s）与网络抖动
    this.staleWaitingRecoveryTimer = setTimeout(() => {
      this.staleWaitingRecoveryTimer = undefined;
      if (this.state === 'paired' && this.staleWaitingCount > 0) {
        this.reconnectAfterStaleWaiting();
      }
    }, STALE_WAITING_RECOVERY_MS);
    this.staleWaitingRecoveryTimer.unref?.();
  }

  private clearStaleWaitingRecoveryTimer(): void {
    if (!this.staleWaitingRecoveryTimer) return;
    clearTimeout(this.staleWaitingRecoveryTimer);
    this.staleWaitingRecoveryTimer = undefined;
  }

  private reconnectAfterStaleWaiting(reconnectDelayMs = 0): void {
    this.clearStaleWaitingRecoveryTimer();
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    const staleSocket = this.socket;
    this.socket = undefined;
    if (reconnectDelayMs > 0) {
      // 延迟重连期间旧 socket 不可用，先切出 paired 防止继续发送
      this.setState('connecting');
    }
    staleSocket?.close();
    if (reconnectDelayMs > 0) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.manuallyClosed || this.terminalClose) return;
        this.connect();
      }, reconnectDelayMs);
      this.reconnectTimer.unref?.();
      return;
    }
    this.connect();
  }

  // ═══════════════ 终态与发送 ═══════════════

  private enterError(error: Error): void {
    this.terminalClose = true;
    this.stopHeartbeat();
    this.clearStaleWaitingRecoveryTimer();
    this.setState('error');
    this.options.onError(error);
    this.socket?.close();
  }

  private enterRecoverableError(error: Error): void {
    this.stopHeartbeat();
    this.clearStaleWaitingRecoveryTimer();
    this.setState('error');
    this.options.onError(error);
    this.socket?.close();
  }

  private setState(state: RelayTransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange(state);
  }

  private send(message: RelayOutgoingMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized, 'utf8') > RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      this.options.logger?.warn('[relay] outbound message exceeds hard limit', { type: message.type });
      return false;
    }
    this.socket.send(serialized);
    return true;
  }

  private sendSerialized(message: RelayOutgoingMessage, serialized: string): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(serialized);
    return true;
  }
}
