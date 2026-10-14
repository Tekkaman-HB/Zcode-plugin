/**
 * [INPUT]: 汇集 ./relayAuth、./relayTypes、./relayTransport、./rpcFrameCodec、./ackRelayProtocol、./localServer、./pairingManager、./qrUrl
 * [OUTPUT]: 对外提供 src/remote 的公共面（PairingManager/PairingStatus/RelayTransport/spawnLocalServer/buildRelayQrUrl 及协议类型）
 * [POS]: src/remote 的门面——extension.ts 与 chatProvider 只经此消费，模块内部结构不外泄
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
export { PairingManager, type PairingManagerOptions, type PairingStatus, type StoredPairingAuth, type PairingStorage } from './pairingManager';
export { RelayTransport, type RelayTransportOptions, type RelayTransportState, type RelaySendResult } from './relayTransport';
export { spawnLocalServer, type LocalServerConnection, type LocalServerOptions } from './localServer';
export { createAckRelayProtocol, type AckRelayProtocol, type ByteProtocol, ACK_RELAY_LIMITS } from './ackRelayProtocol';
export { RpcTransportAssembler, encodeRpcFrames, type RpcFrameFault } from './rpcFrameCodec';
export { buildRelayQrUrl, RELAY_REMOTE_PAGE_BASE, type RelayQrParams } from './qrUrl';
export { createDeviceMid, createRelayPassword, createRelayPassHash, calculateRelayProof, type RelayDeviceAuth } from './relayAuth';
export type {
  RelayAppPayload,
  RelayBridgeIdentity,
  RelayDeviceMeta,
  RelayMobileViewState,
  RelayTaskTarget,
  RelayWorkspaceListResult,
  RelayWorkspaceTarget,
  RpcTransportPayload,
} from './relayTypes';
