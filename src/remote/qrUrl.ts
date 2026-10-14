/**
 * [INPUT]: 无运行时依赖（纯 URL 构造）
 * [OUTPUT]: 对外提供 buildRelayQrUrl（deviceSid/passHash → 手机远控页二维码 URL）
 * [POS]: src/remote 的二维码入口层——pairingManager/冒烟脚本共同消费；URL 形态与桌面 buildWebRemoteControlExternalQrUrl 对齐
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 契约：https://zcode.z.ai/remote/v4?sid=<deviceSid>&hash=<passHash>&t=<ts>&mid&name&app_version
 * 手机页对 app_version 只做改写不做拒绝（v4 页面无版本硬门槛，源码实证）。
 */

export const RELAY_REMOTE_PAGE_BASE = 'https://zcode.z.ai/remote/v4';

export interface RelayQrParams {
  deviceSid: string;
  passHash: string;
  deviceMid?: string;
  deviceName?: string;
  appVersion?: string;
}

export function buildRelayQrUrl(params: RelayQrParams): string {
  const url = new URL(RELAY_REMOTE_PAGE_BASE);
  url.searchParams.set('sid', params.deviceSid);
  url.searchParams.set('hash', params.passHash);
  url.searchParams.set('t', String(Date.now()));
  if (params.deviceMid?.trim()) url.searchParams.set('mid', params.deviceMid);
  if (params.deviceName?.trim()) url.searchParams.set('name', params.deviceName);
  if (params.appVersion?.trim()) url.searchParams.set('app_version', params.appVersion);
  return url.toString();
}
