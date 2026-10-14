/**
 * [INPUT]: 无运行时依赖（纯类型与校验）；协议契约逆向自 ZCode v3.15.1 源码仓库
 * [OUTPUT]: 对外提供 relay 线消息类型（RelayOutgoingMessage/RelayIncomingMessage）、应用载荷类型（RelayAppPayload 及子类型）、
 *           常量（心跳/抖动/帧上限 + jitter 函数）、校验器（parseRelayMessage/parseRelayAppPayload/isRawTransportCandidate/rawIdentityMatches）、
 *           二进制线格式工具（crc32WireBytes/encodeWireBytesBase64/decodeWireBase64）
 * [POS]: src/remote 的协议事实层——桌面 webRemoteControlTransport 消费的全部协议类型与此对齐；relayAuth/relayTransport/ackRelayProtocol 共同依赖
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 接口契约（ZCode 源码仓库 packages/shared/src/web-remote-control*.ts 双向实证，2026-10）：
 *   relay 线消息（WebSocket JSON，双向）：
 *     device_register_init{device_mid,pass_hash,meta} → device_register_ack{device_sid}
 *     auth_init{role:'device'|'terminal',device_sid,meta} → auth_challenge{nonce} → auth_response{device_sid,proof}
 *     auth_ack|pair_status_ack{pair_status:'waiting'|'matched'}；pair_status_query{device_sid}（心跳）
 *     data{payload}（业务帧）；error{code:'AUTH_FAILED'|'DEVICE_OFFLINE'|'KICKED'|'WRONG_PARAM'|'INTERNAL',message}
 *   proof = HMAC-SHA256(passHash, `${nonce}|${role}|${deviceSid}`) 的 base64url（见 relayAuth.ts）
 *   rpc-frame{zcode_type,bridgeSessionId,seq,messageSeq,fragmentIndex,fragmentCount,messageBytes,checksum{algorithm:'crc32',value},dataBase64}
 *   rpc-frame-ack{zcode_type,bridgeSessionId,ackMessageSeq}
 *   物理帧上限 1MiB、消息上限 16MiB、分片上限 64、装配超时 30s（与官方 PROTOCOL_V4_LIMITS 对齐）
 */

// ═══════════════ 常量与抖动（与桌面实现逐字节对齐） ═══════════════

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_JITTER_MS = 2_000;
export const HEARTBEAT_ACK_TIMEOUT_MS = 30_000;
export const RECONNECT_JITTER_MS = 2_000;
export const STALE_WAITING_RECOVERY_MS = 15_000;

export const RPC_TRANSPORT_LIMITS = {
  maxPhysicalFrameBytes: 1024 * 1024,
  maxMessageBytes: 16 * 1024 * 1024,
  maxFragments: 64,
  assemblyTimeoutMs: 30_000,
  transportIdMaxChars: 256,
} as const;

function safeRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999999, Math.max(0, value));
}

export function getHeartbeatDelayMs(configuredJitterMs?: number, random: () => number = Math.random): number {
  const jitterMs = Math.min(configuredJitterMs ?? Math.min(HEARTBEAT_JITTER_MS, HEARTBEAT_INTERVAL_MS * 0.2), HEARTBEAT_INTERVAL_MS - 1);
  const minDelayMs = Math.max(1, HEARTBEAT_INTERVAL_MS - jitterMs);
  const maxDelayMs = HEARTBEAT_INTERVAL_MS + jitterMs;
  return minDelayMs + Math.floor(safeRandom(random) * (maxDelayMs - minDelayMs + 1));
}

export function getReconnectJitterMs(random: () => number = Math.random): number {
  return Math.floor(safeRandom(random) * (RECONNECT_JITTER_MS + 1));
}

// ═══════════════ 线消息类型 ═══════════════

export interface RelayDeviceMeta {
  platform: string;
  version: string;
  name: string;
}

export type RelayPairStatus = 'waiting' | 'matched';
export type RelayErrorCode = 'AUTH_FAILED' | 'DEVICE_OFFLINE' | 'KICKED' | 'WRONG_PARAM' | 'INTERNAL';

export type RelayOutgoingMessage =
  | { type: 'device_register_init'; device_mid: string; pass_hash: string; meta: RelayDeviceMeta; client_ts?: number }
  | { type: 'auth_init'; role: 'device'; device_sid: string; meta: RelayDeviceMeta; client_ts?: number }
  | { type: 'auth_response'; device_sid: string; proof: string; client_ts?: number }
  | { type: 'pair_status_query'; device_sid: string; client_ts?: number }
  | { type: 'data'; payload: unknown; client_ts?: number };

export type RelayIncomingMessage =
  | { type: 'device_register_ack'; device_sid: string; server_ts?: number }
  | { type: 'auth_challenge'; nonce: string; server_ts?: number }
  | { type: 'auth_ack'; device_sid: string; terminal_sid?: string; pair_status: RelayPairStatus; server_ts?: number }
  | { type: 'pair_status_ack'; terminal_sid?: string; pair_status: RelayPairStatus; server_ts?: number }
  | { type: 'data'; payload: unknown; server_ts?: number }
  | { type: 'error'; code: RelayErrorCode; message: string; server_ts?: number };

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/** 宽进严出：只机械校验 type 判别字段与必要标量，未知字段容忍（与官方「tolerated unknowns」一致） */
export function parseRelayMessage(raw: string): RelayIncomingMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const msg = parsed as Record<string, unknown>;
  switch (msg.type) {
    case 'device_register_ack':
      return isString(msg.device_sid) && msg.device_sid ? { type: 'device_register_ack', device_sid: msg.device_sid } : null;
    case 'auth_challenge':
      return isString(msg.nonce) && msg.nonce ? { type: 'auth_challenge', nonce: msg.nonce } : null;
    case 'auth_ack':
    case 'pair_status_ack': {
      const pairStatus = msg.pair_status;
      if (pairStatus !== 'waiting' && pairStatus !== 'matched') return null;
      if (msg.type === 'auth_ack') {
        if (!isString(msg.device_sid)) return null;
        return { type: 'auth_ack', device_sid: msg.device_sid, pair_status: pairStatus };
      }
      return { type: 'pair_status_ack', pair_status: pairStatus };
    }
    case 'data':
      return { type: 'data', payload: msg.payload };
    case 'error': {
      const code = msg.code;
      if (code !== 'AUTH_FAILED' && code !== 'DEVICE_OFFLINE' && code !== 'KICKED' && code !== 'WRONG_PARAM' && code !== 'INTERNAL') return null;
      return { type: 'error', code, message: isString(msg.message) ? msg.message : '' };
    }
    default:
      return null;
  }
}

// ═══════════════ 应用载荷类型（手机 ↔ 设备 业务面） ═══════════════

export type RelayRequestId = string;

export interface RelayWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  label: string;
  kind: 'local' | 'remote';
  connectionState?: 'connected' | 'disconnected' | 'reconnecting';
}

export interface RelayTaskTarget {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  workspaceLabel: string;
  workspaceKind: 'local' | 'remote';
  createdAt: number;
  updatedAt: number;
  displayStatus?: 'idle' | 'running' | 'completed' | 'error';
  unreadAt?: number;
}

export interface RelayWorkspaceListResult {
  workspaces: RelayWorkspaceTarget[];
  tasks?: RelayTaskTarget[];
  activeWorkspaceKey?: string;
  activeTaskId?: string;
}

export interface RelayMobileViewState {
  activeWorkspaceKey?: string;
  activeTaskId?: string;
  updatedAt: number;
}

export interface RelayBridgeIdentity {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
}

export type RpcTransportFramePayload = RelayBridgeIdentity & {
  zcode_type: 'rpc-frame';
  seq: number;
  messageSeq: number;
  fragmentIndex: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: { algorithm: 'crc32'; value: string };
  dataBase64: string;
};

export type RpcTransportAckPayload = RelayBridgeIdentity & {
  zcode_type: 'rpc-frame-ack';
  ackMessageSeq: number;
};

export type RpcTransportPayload = RpcTransportFramePayload | RpcTransportAckPayload;

export type RelayAppPayload =
  // 请求/应答（手机 → 设备为主）
  | { zcode_type: 'telemetry-report'; event: unknown }
  | { zcode_type: 'bootstrap-request'; requestId: RelayRequestId }
  | { zcode_type: 'bootstrap-response'; requestId: RelayRequestId; success: true; result: unknown }
  | { zcode_type: 'workspace-list-request'; requestId: RelayRequestId }
  | { zcode_type: 'workspace-list-response'; requestId: RelayRequestId; success: true; result: RelayWorkspaceListResult }
  | { zcode_type: 'workspace-list-updated'; result: RelayWorkspaceListResult }
  | (RelayBridgeIdentity & { zcode_type: 'workspace-bridge-open'; requestId: RelayRequestId; workspaceKey: string; taskId?: string })
  | (RelayBridgeIdentity & { zcode_type: 'workspace-bridge-ready'; requestId: RelayRequestId; bridge: unknown })
  | { zcode_type: 'workspace-bridge-error'; requestId?: RelayRequestId; bridgeSessionId?: string; bridgeGeneration?: number; recoveryId?: string; reason: string; error: string }
  | { zcode_type: 'workspace-reconnect-request'; requestId: RelayRequestId; workspaceKey: string }
  | { zcode_type: 'workspace-reconnect-response'; requestId: RelayRequestId; workspaceKey: string; success: boolean; error?: string }
  | { zcode_type: 'mobile-view-state-update'; viewState: RelayMobileViewState }
  | { zcode_type: 'platform-request'; requestId: RelayRequestId; method: string; args?: unknown }
  | { zcode_type: 'platform-response'; requestId: RelayRequestId; method: string; success: boolean; result?: unknown; error?: string }
  | { zcode_type: 'bridge-degraded'; bridgeSessionId: string; bridgeGeneration?: number; recoveryId?: string; reason: string }
  | { zcode_type: 'app-error'; requestId?: RelayRequestId; bridgeSessionId?: string; reason: string; error: string }
  | { zcode_type: 'mobile-diagnostic'; [k: string]: unknown }
  | RpcTransportPayload;

/** 是否为 raw RPC 传输帧（进 ACK 协议前的高频快路径判别） */
export function isRawTransportCandidate(payload: unknown): payload is RpcTransportPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const type = (payload as { zcode_type?: unknown }).zcode_type;
  return type === 'rpc-frame' || type === 'rpc-frame-ack';
}

/** 帧身份匹配：bridgeSessionId/Generation/recoveryId 三元组一致才可进入装配 */
export function rawIdentityMatches(identity: RelayBridgeIdentity, candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const v = candidate as Record<string, unknown>;
  return (
    v.bridgeSessionId === identity.bridgeSessionId &&
    v.bridgeGeneration === identity.bridgeGeneration &&
    v.recoveryId === identity.recoveryId
  );
}

/** 应用载荷校验：判别 zcode_type 与关键字段；未知变体拒绝（返回 null 由调用方丢弃） */
export function parseRelayAppPayload(payload: unknown): RelayAppPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const reqId = (): RelayRequestId | null => (isString(p.requestId) && p.requestId ? p.requestId : null);
  switch (p.zcode_type) {
    case 'telemetry-report':
      return { zcode_type: 'telemetry-report', event: p.event };
    case 'bootstrap-request': {
      const requestId = reqId();
      return requestId ? { zcode_type: 'bootstrap-request', requestId } : null;
    }
    case 'bootstrap-response':
      return p.success === true ? { zcode_type: 'bootstrap-response', requestId: String(p.requestId), success: true, result: p.result } : null;
    case 'workspace-list-request': {
      const requestId = reqId();
      return requestId ? { zcode_type: 'workspace-list-request', requestId } : null;
    }
    case 'workspace-list-response': {
      const requestId = reqId();
      if (!requestId || !isWorkspaceListResult(p.result)) return null;
      return { zcode_type: 'workspace-list-response', requestId, success: true, result: p.result };
    }
    case 'workspace-list-updated':
      return isWorkspaceListResult(p.result) ? { zcode_type: 'workspace-list-updated', result: p.result } : null;
    case 'workspace-bridge-open': {
      const requestId = reqId();
      if (!requestId || !isString(p.bridgeSessionId) || !isString(p.workspaceKey)) return null;
      return {
        zcode_type: 'workspace-bridge-open',
        requestId,
        bridgeSessionId: p.bridgeSessionId,
        ...(typeof p.bridgeGeneration === 'number' ? { bridgeGeneration: p.bridgeGeneration } : {}),
        ...(isString(p.recoveryId) ? { recoveryId: p.recoveryId } : {}),
        workspaceKey: p.workspaceKey,
        ...(isString(p.taskId) ? { taskId: p.taskId } : {}),
      };
    }
    case 'workspace-bridge-ready':
    case 'workspace-bridge-error': {
      const reason = p.reason;
      if (!isString(reason) || !isString(p.error)) return null;
      if (p.zcode_type === 'workspace-bridge-ready') {
        const requestId = reqId();
        return requestId && isString(p.bridgeSessionId)
          ? { zcode_type: 'workspace-bridge-ready', requestId, bridgeSessionId: p.bridgeSessionId, bridge: p.bridge }
          : null;
      }
      return {
        zcode_type: 'workspace-bridge-error',
        ...(isString(p.requestId) ? { requestId: p.requestId } : {}),
        ...(isString(p.bridgeSessionId) ? { bridgeSessionId: p.bridgeSessionId } : {}),
        reason,
        error: p.error,
      };
    }
    case 'workspace-reconnect-request': {
      const requestId = reqId();
      return requestId && isString(p.workspaceKey)
        ? { zcode_type: 'workspace-reconnect-request', requestId, workspaceKey: p.workspaceKey }
        : null;
    }
    case 'mobile-view-state-update': {
      const viewState = p.viewState;
      if (typeof viewState !== 'object' || viewState === null || typeof (viewState as { updatedAt?: unknown }).updatedAt !== 'number') return null;
      return { zcode_type: 'mobile-view-state-update', viewState: viewState as RelayMobileViewState };
    }
    case 'platform-request': {
      const requestId = reqId();
      return requestId && isString(p.method)
        ? { zcode_type: 'platform-request', requestId, method: p.method, ...(p.args !== undefined ? { args: p.args } : {}) }
        : null;
    }
    case 'bridge-degraded':
      return isString(p.bridgeSessionId) && isString(p.reason)
        ? {
            zcode_type: 'bridge-degraded',
            bridgeSessionId: p.bridgeSessionId,
            ...(typeof p.bridgeGeneration === 'number' ? { bridgeGeneration: p.bridgeGeneration } : {}),
            ...(isString(p.recoveryId) ? { recoveryId: p.recoveryId } : {}),
            reason: p.reason,
          }
        : null;
    case 'app-error':
      return isString(p.reason) && isString(p.error)
        ? {
            zcode_type: 'app-error',
            ...(isString(p.requestId) ? { requestId: p.requestId } : {}),
            ...(isString(p.bridgeSessionId) ? { bridgeSessionId: p.bridgeSessionId } : {}),
            reason: p.reason,
            error: p.error,
          }
        : null;
    case 'mobile-diagnostic':
      return { zcode_type: 'mobile-diagnostic', ...(p as Record<string, unknown>) };
    default:
      return isRawTransportCandidate(payload) ? (payload as RpcTransportPayload) : null;
  }
}

function isWorkspaceListResult(value: unknown): value is RelayWorkspaceListResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.workspaces)) return false;
  return v.workspaces.every(
    (w) =>
      typeof w === 'object' &&
      w !== null &&
      isString((w as { workspacePath?: unknown }).workspacePath) &&
      isString((w as { label?: unknown }).label),
  );
}

// ═══════════════ 二进制线格式工具（crc32 / canonical base64） ═══════════════

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function crc32WireBytes(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

export function encodeWireBytesBase64(bytes: Uint8Array): string {
  let result = '';
  let block: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const a = bytes[offset] ?? 0;
    const hasB = offset + 1 < bytes.byteLength;
    const hasC = offset + 2 < bytes.byteLength;
    const b = hasB ? (bytes[offset + 1] ?? 0) : 0;
    const c = hasC ? (bytes[offset + 2] ?? 0) : 0;
    block.push(
      BASE64_ALPHABET[a >>> 2]!,
      BASE64_ALPHABET[((a & 0x03) << 4) | (b >>> 4)]!,
      hasB ? BASE64_ALPHABET[((b & 0x0f) << 2) | (c >>> 6)]! : '=',
      hasC ? BASE64_ALPHABET[c & 0x3f]! : '=',
    );
    if (block.length >= 16_384) {
      result += block.join('');
      block = [];
    }
  }
  return result + block.join('');
}

export function decodeWireBase64(value: string): Uint8Array | null {
  if (!BASE64_RE.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let writeOffset = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const a = BASE64_ALPHABET.indexOf(value[offset]!);
    const b = BASE64_ALPHABET.indexOf(value[offset + 1]!);
    const c = value[offset + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[offset + 2]!);
    const d = value[offset + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(value[offset + 3]!);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    if (writeOffset < output.length) output[writeOffset++] = combined >>> 16;
    if (writeOffset < output.length) output[writeOffset++] = (combined >>> 8) & 0xff;
    if (writeOffset < output.length) output[writeOffset++] = combined & 0xff;
  }
  return output;
}

/** canonical base64 判定（与官方 isCanonicalBase64 同义：可解码、非空、重编码一致） */
export function isCanonicalBase64(value: string): boolean {
  if (value.length < 4 || value.length > RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) return false;
  const decoded = decodeWireBase64(value);
  return decoded !== null && decoded.byteLength > 0 && encodeWireBytesBase64(decoded) === value;
}
