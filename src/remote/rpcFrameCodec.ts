/**
 * [INPUT]: 依赖 ./relayTypes 的 base64/crc32/常量工具
 * [OUTPUT]: 对外提供 RpcFrameFault、encodeRpcFrames（消息字节 → 物理帧批次）、RpcTransportAssembler（帧 → 消息字节装配状态机）、
 *           measureRelayEnvelopeBytes（最坏情形信封计量）、validateRpcFrame（帧结构校验）
 * [POS]: src/remote 的 rpc-frame 编解码层——ackRelayProtocol 消费；移植自官方 shared/web-remote-control-rpc-transport（去 zod，手写校验）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 帧语义（源码实证）：
 *   rpc-frame{bridgeSessionId,bridgeGeneration?,recoveryId?,seq,messageSeq,fragmentIndex,fragmentCount,messageBytes,
 *             checksum{algorithm:'crc32',value:hex8},dataBase64}
 *   · seq=物理帧序（每帧+1）；messageSeq=逻辑消息序（每消息+1）；分片数 ≤64；消息 ≤16MiB；物理帧（含信封）≤1MiB
 *   · 信封计量取最坏情形（client_ts+server_ts 皆为 MAX_SAFE_INTEGER 的十进制长度），保证 ACK 计量不小于实际
 *   · 装配校验顺序有讲究：foreign identity 先拒（非终态）→ terminal 短路 → base64 硬闸 → 结构校验 → 重复/间隙/元数据一致性
 */
import {
  crc32WireBytes,
  decodeWireBase64,
  encodeWireBytesBase64,
  isCanonicalBase64,
  RPC_TRANSPORT_LIMITS,
  type RelayBridgeIdentity,
  type RpcTransportFramePayload,
} from './relayTypes';

export interface RpcFrameFault {
  reasonCode: string;
  terminal: boolean;
  seq?: number;
  messageSeq?: number;
  expectedSeq?: number;
  expectedMessageSeq?: number;
}

export class RpcFrameEncodingError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
    this.name = 'RpcFrameEncodingError';
  }
}

const ID_RE = /^[A-Za-z0-9._~-]+$/u;

function isPositiveSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function isNonnegSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** 信封最坏情形字节（client_ts/server_ts 均取 MAX_SAFE_INTEGER 的十进制位数） */
export function measureRelayEnvelopeBytes(payload: unknown): number {
  const envelope = {
    type: 'data',
    payload,
    client_ts: Number.MAX_SAFE_INTEGER,
    server_ts: Number.MAX_SAFE_INTEGER,
  };
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8');
}

function base64Length(decodedBytes: number): number {
  return 4 * Math.ceil(decodedBytes / 3);
}

function assertPositiveSafe(value: number, reasonCode: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RpcFrameEncodingError(reasonCode);
}

// ═══════════════ 编码：消息字节 → 帧批次 ═══════════════

export interface EncodeRpcFramesOptions extends RelayBridgeIdentity {
  firstPhysicalSeq: number;
  messageSeq: number;
}

function identityFrom(value: RelayBridgeIdentity): RelayBridgeIdentity {
  if (
    typeof value.bridgeSessionId !== 'string' ||
    value.bridgeSessionId.length < 1 ||
    value.bridgeSessionId.length > RPC_TRANSPORT_LIMITS.transportIdMaxChars ||
    !ID_RE.test(value.bridgeSessionId)
  ) {
    throw new RpcFrameEncodingError('remote.rpcFrame.invalidIdentity');
  }
  // 只取身份三元组——官方 zod strict 解析会剥未知字段（firstPhysicalSeq 等 options 键），
  // 不剥则帧携带多余字段被线上页面 strict schema 拒收（terminal fault → recover 风暴，2026-10 实证）
  return {
    bridgeSessionId: value.bridgeSessionId,
    ...(value.bridgeGeneration !== undefined ? { bridgeGeneration: value.bridgeGeneration } : {}),
    ...(value.recoveryId !== undefined ? { recoveryId: value.recoveryId } : {}),
  };
}

/** 二分求单帧解码预算：固定壳 + base64(len) ≤ 物理上限 的最大 len */
function findDecodedBudget(params: {
  identity: RelayBridgeIdentity;
  endSeq: number;
  messageSeq: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: { algorithm: 'crc32'; value: string };
}): number {
  const empty: RpcTransportFramePayload = {
    zcode_type: 'rpc-frame',
    ...params.identity,
    seq: params.endSeq,
    messageSeq: params.messageSeq,
    fragmentIndex: params.fragmentCount - 1,
    fragmentCount: params.fragmentCount,
    messageBytes: params.messageBytes,
    checksum: params.checksum,
    dataBase64: '',
  };
  const fixedBytes = measureRelayEnvelopeBytes(empty);
  let low = 0;
  let high = params.messageBytes;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fixedBytes + base64Length(middle) <= RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function encodeRpcFrames(bytes: Uint8Array, options: EncodeRpcFramesOptions): readonly RpcTransportFramePayload[] {
  const identity = identityFrom(options);
  assertPositiveSafe(options.firstPhysicalSeq, 'remote.rpcFrame.invalidPhysicalSeq');
  assertPositiveSafe(options.messageSeq, 'remote.rpcFrame.invalidMessageSeq');
  if (bytes.byteLength === 0) throw new RpcFrameEncodingError('remote.rpcFrame.emptyMessage');
  if (bytes.byteLength > RPC_TRANSPORT_LIMITS.maxMessageBytes) throw new RpcFrameEncodingError('remote.rpcFrame.messageTooLarge');
  const checksum = Object.freeze({ algorithm: 'crc32' as const, value: crc32WireBytes(bytes) });

  let fragmentCount = 1;
  let decodedBudget = 0;
  for (;;) {
    const endSeq = options.firstPhysicalSeq + fragmentCount - 1;
    if (!Number.isSafeInteger(endSeq)) throw new RpcFrameEncodingError('remote.rpcFrame.sequenceOverflow');
    decodedBudget = findDecodedBudget({
      identity,
      endSeq,
      messageSeq: options.messageSeq,
      fragmentCount,
      messageBytes: bytes.byteLength,
      checksum,
    });
    if (decodedBudget < 1) throw new RpcFrameEncodingError('remote.rpcFrame.envelopeTooLarge');
    const required = Math.ceil(bytes.byteLength / decodedBudget);
    if (required > RPC_TRANSPORT_LIMITS.maxFragments) throw new RpcFrameEncodingError('remote.rpcFrame.fragmentLimitExceeded');
    if (required <= fragmentCount) break;
    fragmentCount = required;
  }

  const frames: RpcTransportFramePayload[] = [];
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * decodedBudget;
    const end = Math.min(bytes.byteLength, start + decodedBudget);
    const frame: RpcTransportFramePayload = {
      zcode_type: 'rpc-frame',
      ...identity,
      seq: options.firstPhysicalSeq + fragmentIndex,
      messageSeq: options.messageSeq,
      fragmentIndex,
      fragmentCount,
      messageBytes: bytes.byteLength,
      checksum,
      dataBase64: encodeWireBytesBase64(bytes.subarray(start, end)),
    };
    if (measureRelayEnvelopeBytes(frame) > RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes || !validateRpcFrame(frame)) {
      throw new RpcFrameEncodingError('remote.rpcFrame.internalEnvelopeError');
    }
    frames.push(Object.freeze(frame));
  }
  return Object.freeze(frames);
}

// ═══════════════ 帧结构校验（手写等价官方 zod schema） ═══════════════

export function validateRpcFrame(candidate: unknown): RpcTransportFramePayload | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const v = candidate as Record<string, unknown>;
  if (v.zcode_type !== 'rpc-frame') return null;
  if (
    typeof v.bridgeSessionId !== 'string' ||
    v.bridgeSessionId.length < 1 ||
    v.bridgeSessionId.length > RPC_TRANSPORT_LIMITS.transportIdMaxChars ||
    !ID_RE.test(v.bridgeSessionId)
  ) return null;
  if (v.bridgeGeneration !== undefined && !isNonnegSafeInt(v.bridgeGeneration)) return null;
  if (v.recoveryId !== undefined && (typeof v.recoveryId !== 'string' || !ID_RE.test(v.recoveryId) || v.recoveryId.length > RPC_TRANSPORT_LIMITS.transportIdMaxChars)) return null;
  if (!isPositiveSafeInt(v.seq) || !isPositiveSafeInt(v.messageSeq)) return null;
  if (typeof v.fragmentIndex !== 'number' || !Number.isSafeInteger(v.fragmentIndex) || v.fragmentIndex < 0 || v.fragmentIndex > RPC_TRANSPORT_LIMITS.maxFragments - 1) return null;
  if (typeof v.fragmentCount !== 'number' || !Number.isSafeInteger(v.fragmentCount) || v.fragmentCount < 1 || v.fragmentCount > RPC_TRANSPORT_LIMITS.maxFragments) return null;
  if (v.fragmentIndex >= v.fragmentCount) return null;
  if (typeof v.messageBytes !== 'number' || !Number.isSafeInteger(v.messageBytes) || v.messageBytes < 1 || v.messageBytes > RPC_TRANSPORT_LIMITS.maxMessageBytes) return null;
  if (v.fragmentCount > v.messageBytes) return null;
  const checksum = v.checksum;
  if (
    typeof checksum !== 'object' ||
    checksum === null ||
    (checksum as { algorithm?: unknown }).algorithm !== 'crc32' ||
    typeof (checksum as { value?: unknown }).value !== 'string' ||
    !/^[0-9a-f]{8}$/u.test((checksum as { value: string }).value)
  ) return null;
  if (typeof v.dataBase64 !== 'string' || v.dataBase64.length < 4 || v.dataBase64.length > RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) return null;
  return {
    zcode_type: 'rpc-frame',
    bridgeSessionId: v.bridgeSessionId,
    ...(v.bridgeGeneration !== undefined ? { bridgeGeneration: v.bridgeGeneration } : {}),
    ...(v.recoveryId !== undefined ? { recoveryId: v.recoveryId } : {}),
    seq: v.seq,
    messageSeq: v.messageSeq,
    fragmentIndex: v.fragmentIndex,
    fragmentCount: v.fragmentCount,
    messageBytes: v.messageBytes,
    checksum: { algorithm: 'crc32', value: (checksum as { value: string }).value },
    dataBase64: v.dataBase64,
  };
}

// ═══════════════ 装配状态机：帧 → 消息字节 ═══════════════

interface ActiveAssembly {
  messageSeq: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: { algorithm: 'crc32'; value: string };
  firstSeenAt: number;
  stagedBytes: number;
  fragments: Uint8Array[];
  frameFingerprintsBySeq: Map<number, { messageSeq: number; value: string }>;
}

export type AssemblerEvent =
  | { kind: 'incomplete'; messageSeq: number; receivedFragments: number }
  | { kind: 'duplicate'; ackMessageSeq: number | null }
  | { kind: 'complete'; messageSeq: number; bytes: Uint8Array }
  | { kind: 'fault'; fault: RpcFrameFault };

function frameFingerprint(frame: RpcTransportFramePayload, decoded: Uint8Array): { messageSeq: number; value: string } {
  return {
    messageSeq: frame.messageSeq,
    // tombstone 只保留有界元数据 + 分片摘要，不保留整段 base64
    value: JSON.stringify([
      frame.bridgeSessionId,
      frame.bridgeGeneration ?? null,
      frame.recoveryId ?? null,
      frame.seq,
      frame.messageSeq,
      frame.fragmentIndex,
      frame.fragmentCount,
      frame.messageBytes,
      frame.checksum.algorithm,
      frame.checksum.value,
      decoded.byteLength,
      crc32WireBytes(decoded),
    ]),
  };
}

export class RpcTransportAssembler {
  private readonly identity: RelayBridgeIdentity;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private expectedPhysicalSeq: number;
  private expectedMessageSeq: number;
  private lastCompletedMessageSeq: number;
  private physicalSequenceExhausted = false;
  private messageSequenceExhausted = false;
  private settledFrameFingerprintsBySeq = new Map<number, { messageSeq: number; value: string }>();
  private active: ActiveAssembly | null = null;
  private terminalReason: string | null = null;

  constructor(options: RelayBridgeIdentity & { timeoutMs?: number; now?: () => number }) {
    this.identity = identityFrom(options);
    assertPositiveSafe((this.expectedPhysicalSeq = 1), 'remote.rpcFrame.invalidPhysicalSeq');
    this.expectedMessageSeq = 1;
    this.lastCompletedMessageSeq = 0;
    this.timeoutMs = options.timeoutMs ?? RPC_TRANSPORT_LIMITS.assemblyTimeoutMs;
    assertPositiveSafe(this.timeoutMs, 'remote.rpcFrame.invalidTimeout');
    this.now = options.now ?? Date.now;
  }

  get nextExpiryAt(): number | null {
    return this.active ? this.active.firstSeenAt + this.timeoutMs : null;
  }

  private fault(reasonCode: string, terminal: boolean, frame?: Partial<RpcTransportFramePayload>): AssemblerEvent {
    if (terminal) {
      this.terminalReason = reasonCode;
      this.active = null;
    }
    return {
      kind: 'fault',
      fault: {
        reasonCode,
        terminal,
        ...(typeof frame?.seq === 'number' ? { seq: frame.seq } : {}),
        ...(typeof frame?.messageSeq === 'number' ? { messageSeq: frame.messageSeq } : {}),
        expectedSeq: this.expectedPhysicalSeq,
        expectedMessageSeq: this.expectedMessageSeq,
      },
    };
  }

  expire(now: number = this.now()): AssemblerEvent | null {
    if (!this.active || now - this.active.firstSeenAt < this.timeoutMs) return null;
    return this.fault('remote.rpcFrame.assemblyTimeout', true, { messageSeq: this.active.messageSeq });
  }

  accept(candidate: unknown, now: number = this.now()): AssemblerEvent {
    // foreign identity 必须先于 timeout/schema/base64 拒绝，避免坏外片清空 owning assembly
    if (typeof candidate === 'object' && candidate !== null && 'bridgeSessionId' in (candidate as object)) {
      const v = candidate as Record<string, unknown>;
      if (
        v.bridgeSessionId !== this.identity.bridgeSessionId ||
        v.bridgeGeneration !== this.identity.bridgeGeneration ||
        v.recoveryId !== this.identity.recoveryId
      ) {
        return this.fault('remote.rpcFrame.identityMismatch', false);
      }
    }
    if (this.terminalReason) return this.fault(this.terminalReason, true);
    const expired = this.expire(now);
    if (expired) return expired;

    const rawBase64 =
      typeof candidate === 'object' && candidate !== null && 'dataBase64' in candidate
        ? (candidate as { dataBase64?: unknown }).dataBase64
        : undefined;
    if (typeof rawBase64 === 'string' && (rawBase64.length > RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes || !isCanonicalBase64(rawBase64))) {
      return this.fault('remote.rpcFrame.invalidBase64', true);
    }
    const frame = validateRpcFrame(candidate);
    if (!frame) return this.fault('remote.rpcFrame.invalidMetadata', true);
    if (frame.messageBytes > RPC_TRANSPORT_LIMITS.maxMessageBytes) return this.fault('remote.rpcFrame.messageTooLarge', true, frame);
    if (frame.fragmentCount > RPC_TRANSPORT_LIMITS.maxFragments) return this.fault('remote.rpcFrame.fragmentLimitExceeded', true, frame);
    if (measureRelayEnvelopeBytes(frame) > RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) return this.fault('remote.rpcFrame.envelopeTooLarge', true, frame);

    const decoded = decodeWireBase64(frame.dataBase64);
    if (!decoded || decoded.byteLength === 0) return this.fault('remote.rpcFrame.invalidBase64', true, frame);
    const fingerprint = frameFingerprint(frame, decoded);

    const activeFingerprint = this.active?.frameFingerprintsBySeq.get(frame.seq);
    if (activeFingerprint) {
      if (activeFingerprint.value !== fingerprint.value) return this.fault('remote.rpcFrame.conflictingDuplicate', true, frame);
      return { kind: 'duplicate', ackMessageSeq: this.lastCompletedMessageSeq > 0 ? this.lastCompletedMessageSeq : null };
    }
    const settledFingerprint = this.settledFrameFingerprintsBySeq.get(frame.seq);
    if (settledFingerprint) {
      if (settledFingerprint.value === fingerprint.value) {
        return { kind: 'duplicate', ackMessageSeq: this.lastCompletedMessageSeq > 0 ? this.lastCompletedMessageSeq : null };
      }
      if (this.physicalSequenceExhausted && frame.messageSeq !== settledFingerprint.messageSeq) {
        return this.fault('remote.rpcFrame.physicalSequenceExhausted', true, frame);
      }
      return this.fault('remote.rpcFrame.conflictingDuplicate', true, frame);
    }

    if (frame.seq < this.expectedPhysicalSeq) {
      return { kind: 'duplicate', ackMessageSeq: this.lastCompletedMessageSeq > 0 ? this.lastCompletedMessageSeq : null };
    }
    if (this.physicalSequenceExhausted) return this.fault('remote.rpcFrame.physicalSequenceExhausted', true, frame);
    if (this.messageSequenceExhausted && !this.active) return this.fault('remote.rpcFrame.messageSequenceExhausted', true, frame);
    if (frame.seq > this.expectedPhysicalSeq) return this.fault('remote.rpcFrame.physicalGap', true, frame);
    if (frame.messageSeq !== this.expectedMessageSeq) return this.fault('remote.rpcFrame.messageGap', true, frame);
    if (frame.seq === Number.MAX_SAFE_INTEGER && frame.fragmentIndex + 1 < frame.fragmentCount) {
      return this.fault('remote.rpcFrame.physicalSequenceExhausted', true, frame);
    }

    const expectedFragmentIndex = this.active?.fragments.length ?? 0;
    if (frame.fragmentIndex !== expectedFragmentIndex) return this.fault('remote.rpcFrame.fragmentGap', true, frame);
    if (
      this.active &&
      (frame.fragmentCount !== this.active.fragmentCount || frame.messageBytes !== this.active.messageBytes)
    ) {
      return this.fault('remote.rpcFrame.metadataMismatch', true, frame);
    }
    if (this.active && frame.checksum.value !== this.active.checksum.value) {
      return this.fault('remote.rpcFrame.checksumMismatch', true, frame);
    }
    if (!this.active) {
      this.active = {
        messageSeq: frame.messageSeq,
        fragmentCount: frame.fragmentCount,
        messageBytes: frame.messageBytes,
        checksum: frame.checksum,
        firstSeenAt: now,
        stagedBytes: 0,
        fragments: [],
        frameFingerprintsBySeq: new Map(),
      };
    }
    if (this.active.stagedBytes + decoded.byteLength > this.active.messageBytes) {
      return this.fault('remote.rpcFrame.lengthMismatch', true, frame);
    }
    this.active.fragments.push(decoded);
    this.active.frameFingerprintsBySeq.set(frame.seq, fingerprint);
    this.active.stagedBytes += decoded.byteLength;
    if (frame.seq === Number.MAX_SAFE_INTEGER) {
      this.physicalSequenceExhausted = true;
    } else {
      this.expectedPhysicalSeq += 1;
    }

    if (this.active.fragments.length < this.active.fragmentCount) {
      return { kind: 'incomplete', messageSeq: frame.messageSeq, receivedFragments: this.active.fragments.length };
    }
    if (this.active.stagedBytes !== this.active.messageBytes) {
      return this.fault('remote.rpcFrame.lengthMismatch', true, frame);
    }
    const completedBytes = new Uint8Array(this.active.messageBytes);
    let offset = 0;
    for (const fragment of this.active.fragments) {
      completedBytes.set(fragment, offset);
      offset += fragment.byteLength;
    }
    if (crc32WireBytes(completedBytes) !== this.active.checksum.value) {
      return this.fault('remote.rpcFrame.checksumMismatch', true, frame);
    }
    const completed = this.active;
    const messageSeq = completed.messageSeq;
    this.settledFrameFingerprintsBySeq = new Map(completed.frameFingerprintsBySeq);
    this.active = null;
    this.lastCompletedMessageSeq = messageSeq;
    if (messageSeq === Number.MAX_SAFE_INTEGER) {
      this.messageSequenceExhausted = true;
    } else {
      this.expectedMessageSeq += 1;
    }
    return { kind: 'complete', messageSeq, bytes: completedBytes };
  }
}
