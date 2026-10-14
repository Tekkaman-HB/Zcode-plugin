/**
 * [INPUT]: 依赖 node:crypto 的 randomBytes/createHash/createHmac
 * [OUTPUT]: 对外提供 createRelayPassword/createRelayPassHash/calculateRelayProof、RelayDeviceAuth（register|persisted 两态）
 * [POS]: src/remote 的配对凭据层——relayTransport 消费；口令/哈希/证明的算法与桌面端逐字节兼容
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 契约（源码实证）：
 *   password = randomBytes(24).toString('base64url')
 *   passHash = sha256(password) 的 base64（非 url 变体——注意与 proof 不同）
 *   proof    = HMAC-SHA256(passHash, `${nonce}|${role}|${deviceSid}`) 的 base64url
 * 安全约束：passHash 等价于配对口令（二维码明文携带），只进协议字段与 globalState，严禁日志。
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { RelayBridgeIdentity } from './relayTypes';

export type RelayRole = 'device' | 'terminal';

export function createRelayPassword(): string {
  return randomBytes(24).toString('base64url');
}

export function createRelayPassHash(password: string): string {
  return createHash('sha256').update(password).digest('base64');
}

export function calculateRelayProof(passHash: string, nonce: string, role: RelayRole, deviceSid: string): string {
  return createHmac('sha256', passHash).update(`${nonce}|${role}|${deviceSid}`).digest('base64url');
}

/** 设备注册身份：register（首次，仅口令哈希）→ persisted（注册成功后，sid+哈希） */
export type RelayDeviceAuth =
  | { mode: 'register'; passHash: string }
  | { mode: 'persisted'; deviceSid: string; passHash: string };

/** 设备稳定身份（UUID 格式——官方桌面端 telemetry deviceMid 同款；自定义格式注册可成功但配对被拒，2026-10 实证） */
export function createDeviceMid(_namespace: string): string {
  return randomUUID();
}

/** bridge 会话 id（进入 rpc-frame 身份三元组，字符集须匹配 [A-Za-z0-9._~-]{1,256}） */
export function createBridgeSessionId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString('base64url')}`;
}

export type { RelayBridgeIdentity };
