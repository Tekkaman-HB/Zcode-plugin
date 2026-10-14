/**
 * [INPUT]: 依赖 ./relayTransport（设备通道）、./ackRelayProtocol（可靠字节通道）、./localServer（本地服务宿主）、
 *          ./relayAuth、./qrUrl、./relayTypes；不依赖 vscode
 * [OUTPUT]: 对外提供 PairingManager（配对编排：注册/二维码/状态映射/bridge 生命周期/payload 路由）、PairingStatus、StoredPairingAuth
 * [POS]: src/remote 的编排层——extension.ts 装配（常驻），chatProvider 经它驱动 webview 配对面板；移植自桌面 webRemoteControlManager 的必要子集
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 语义（源码实证）：
 *   · 单 bridge：手机切工作区=新 bridge-open，旧 bridge 及其 server 进程整体释放后重建（桌面同款）
 *   · bridge-ready 必须先进普通 app 传输，才允许 queued raw 帧开闸（readyAnnounced 后 flushPendingFrames）
 *   · 断线窗口内出向响应缓冲（50 条 / 5s 超时丢弃；重配对 flush）
 *   · workspace-list 推送去重：JSON 签名比对，成员/标题/状态/未读任一变化才推
 *   · platform-request v1 全部安全降级（手机端「添加远程连接」类入口不可用，不影响聊天）
 */
import { createAckRelayProtocol, type AckRelayProtocol } from './ackRelayProtocol';
import { createDeviceMid, createRelayPassHash, createRelayPassword, type RelayDeviceAuth } from './relayAuth';
import type { LocalServerConnection } from './localServer';
import { RelayTransport, type RelaySendResult, type RelayTransportState } from './relayTransport';
import { buildRelayQrUrl } from './qrUrl';
import {
  RPC_TRANSPORT_LIMITS,
  type RelayAppPayload,
  type RelayBridgeIdentity,
  type RelayMobileViewState,
  type RelayTaskTarget,
  type RelayWorkspaceListResult,
  type RelayWorkspaceTarget,
} from './relayTypes';

export type PairingStatus =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; qrUrl: string }
  | { kind: 'active'; qrUrl: string }
  | { kind: 'error'; message: string };

export interface StoredPairingAuth {
  deviceMid: string;
  deviceSid: string;
  passHash: string;
}

export interface PairingStorage {
  load(): Promise<StoredPairingAuth | undefined>;
  save(auth: StoredPairingAuth): Promise<void>;
  clear(): Promise<void>;
}

export interface PairingManagerOptions {
  relayWsUrl: string;
  deviceName: string;
  appVersion: string;
  /** 联调用：透传 relayTransport 的 sendDeviceIdHeader=false（浏览器路由对称），生产缺省 true */
  sendDeviceIdHeader?: boolean;
  /** bridge-open 时懒拉起本地 zcode-server（cwd 绑定目标工作区） */
  spawnServer(target: RelayWorkspaceTarget): Promise<LocalServerConnection>;
  listWorkspaces(): RelayWorkspaceTarget[];
  listTasks(): RelayTaskTarget[];
  storage: PairingStorage;
  onStatus(status: PairingStatus): void;
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

interface BridgeRuntime {
  identity: RelayBridgeIdentity;
  ack: AckRelayProtocol;
  server: LocalServerConnection;
  readyAnnounced: boolean;
  degraded: boolean;
  dispose(): void;
}

const OUTBOUND_BUFFER_LIMIT = 50;
const OUTBOUND_BUFFER_TIMEOUT_MS = 5_000;

function resolveWorkspaceKey(target: Pick<RelayWorkspaceTarget, 'workspacePath' | 'workspaceIdentity'>): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function buildListSignature(result: RelayWorkspaceListResult): string {
  const workspaceEntries = result.workspaces
    .map((w) => JSON.stringify([resolveWorkspaceKey(w), w.kind, w.connectionState ?? 'connected', w.label]))
    .sort();
  const taskEntries = (result.tasks ?? [])
    .map((t) => JSON.stringify([resolveWorkspaceKey(t), t.taskId, t.title, t.displayStatus ?? 'idle', typeof t.unreadAt === 'number' ? t.unreadAt : '']))
    .sort();
  return JSON.stringify([workspaceEntries, taskEntries]);
}

export class PairingManager {
  private transport: RelayTransport | null = null;
  private auth: { deviceMid: string; deviceSid?: string; passHash: string } | null = null;
  private bridge: BridgeRuntime | null = null;
  private mobileViewState: RelayMobileViewState | undefined;
  private pendingOutbound: RelayAppPayload[] = [];
  private pendingOutboundTimer: ReturnType<typeof setTimeout> | undefined;
  private pushedListSignature = '';
  private lastStatus: PairingStatus = { kind: 'idle' };
  private starting = false;
  /** 二维码 URL 按身份缓存（t 只在身份变化时刷新——频繁重生成会导致面板闪烁与缓存失效） */
  private cachedQrUrl: string | null = null;
  private cachedQrKey = '';
  /** 手机断开宽限计时（relay pair_status 抖动不立即降级——桌面 MOBILE_DISCONNECT_STATUS_GRACE_MS 同款，0.5.21 补移植） */
  private mobileDisconnectGraceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: PairingManagerOptions) {}

  // ═══════════════ 生命周期 ═══════════════

  async start(): Promise<void> {
    if (this.transport || this.starting) return;
    this.starting = true;
    try {
      const stored = await this.options.storage.load().catch(() => undefined);
      const deviceMid = stored?.deviceMid ?? createDeviceMid('zcode-vscode');
      const passHash = stored?.passHash ?? createRelayPassHash(createRelayPassword());
      this.auth = { deviceMid, ...(stored?.deviceSid ? { deviceSid: stored.deviceSid } : {}), passHash };
      const transportAuth: RelayDeviceAuth = stored?.deviceSid
        ? { mode: 'persisted', deviceSid: stored.deviceSid, passHash }
        : { mode: 'register', passHash };
      this.emitStatus({ kind: 'starting' });
      this.transport = new RelayTransport({
        relayWsUrl: this.options.relayWsUrl,
        deviceMid,
        auth: transportAuth,
        meta: { platform: process.platform, version: this.options.appVersion, name: this.options.deviceName },
        logger: this.options.logger,
        ...(this.options.sendDeviceIdHeader === false ? { sendDeviceIdHeader: false } : {}),
        onRegisteredAuth: (registered) => {
          this.auth = { deviceMid, deviceSid: registered.deviceSid, passHash: registered.passHash };
          void this.options.storage.save({ deviceMid, deviceSid: registered.deviceSid, passHash: registered.passHash }).catch((error) => {
            this.options.logger.warn('[pairing] 持久化配对身份失败', { message: error instanceof Error ? error.message : String(error) });
          });
        },
        onStateChange: (state) => this.mapTransportState(state),
        onPayload: (payload) => this.routePayload(payload),
        onRawTransportPayload: (payload) => this.bridge?.ack.acceptPayload(payload) ?? false,
        onSendReady: () => {
          this.flushPendingOutbound();
          const bridge = this.bridge;
          if (!bridge || bridge.ack.isDegraded()) return;
          // relay matched 只证明当前 peer 可发送；必须重放未 ACK 批次，对端按 messageSeq 去重
          bridge.ack.replayUnacknowledged();
        },
        onError: (error) => {
          this.options.logger.warn('[pairing] transport error', { message: error.message });
          // 互踢风暴（同设备身份多处在线）：停止重连战争，错误状态驻留——冲突解除后由用户重新发起
          if (error.message.includes('同一设备身份同时只能一端在线')) {
            if (this.mobileDisconnectGraceTimer) {
              clearTimeout(this.mobileDisconnectGraceTimer);
              this.mobileDisconnectGraceTimer = undefined;
            }
            this.transport?.dispose();
            this.transport = null;
            this.emitStatus({ kind: 'error', message: `${error.message}已停止自动重连；冲突解除后重新打开配对面板即可。` });
          }
        },
        onInvalidPersistedAuth: async () => {
          await this.options.storage.clear().catch(() => undefined);
        },
      });
      this.transport.start();
    } finally {
      this.starting = false;
    }
  }

  /** 重置配对：旧 sid/hash 作废（防二维码泄露后旧身份复用），重新注册 */
  async refreshPairing(): Promise<void> {
    await this.stop('refresh-pairing');
    await this.options.storage.clear().catch(() => undefined);
    await this.start();
  }

  async stop(reason = 'manual-stop'): Promise<void> {
    this.sendAppPayload({ zcode_type: 'app-error', reason: 'desktop-disconnected', error: 'VSCode 插件已停止手机远控会话。' });
    this.disposeBridge();
    this.clearPendingOutboundTimer();
    this.pendingOutbound = [];
    this.pushedListSignature = '';
    this.transport?.dispose();
    this.transport = null;
    this.auth = null;
    this.emitStatus({ kind: 'idle' });
    this.options.logger.info('[pairing] stopped', { reason });
  }

  dispose(): void {
    void this.stop('dispose');
  }

  get currentStatus(): PairingStatus {
    return this.lastStatus;
  }

  /** 工作区/任务快照变化（工作区切换、会话增删）→ 去重后推送手机 */
  notifySnapshotChanged(): void {
    if (!this.transport) return;
    this.pushWorkspaceListUpdated();
  }

  // ═══════════════ 状态映射 ═══════════════

  private qrUrl(): string | null {
    if (!this.auth?.deviceSid) return null;
    const key = `${this.auth.deviceSid}:${this.auth.passHash}:${this.auth.deviceMid}`;
    if (this.cachedQrKey !== key || this.cachedQrUrl === null) {
      this.cachedQrKey = key;
      this.cachedQrUrl = buildRelayQrUrl({
        deviceSid: this.auth.deviceSid,
        passHash: this.auth.passHash,
        deviceMid: this.auth.deviceMid,
        deviceName: this.options.deviceName,
        appVersion: this.options.appVersion,
      });
    }
    return this.cachedQrUrl;
  }

  private mapTransportState(state: RelayTransportState): void {
    if (state === 'waiting_terminal' || state === 'paired') {
      const qrUrl = this.qrUrl();
      if (!qrUrl) return;
      if (state === 'paired') {
        // matched 即时确认，并撤销进行中的断开宽限
        if (this.mobileDisconnectGraceTimer) {
          clearTimeout(this.mobileDisconnectGraceTimer);
          this.mobileDisconnectGraceTimer = undefined;
        }
        this.emitStatus({ kind: 'active', qrUrl });
        return;
      }
      if (this.lastStatus.kind === 'active') {
        // 已配对态的 waiting 先进 3s 宽限——relay 对残留 terminal 状态的 matched/waiting 抖动
        // 不降级不重渲染（闪烁根因之一）；宽限期内 matched 回来自动撤销
        if (!this.mobileDisconnectGraceTimer) {
          this.mobileDisconnectGraceTimer = setTimeout(() => {
            this.mobileDisconnectGraceTimer = undefined;
            if (this.lastStatus.kind === 'active' && this.qrUrl()) {
              this.emitStatus({ kind: 'waiting', qrUrl: this.qrUrl()! });
            }
          }, 3_000);
          this.mobileDisconnectGraceTimer.unref?.();
        }
        return;
      }
      this.emitStatus({ kind: 'waiting', qrUrl });
      return;
    }
    if (state === 'connecting' || state === 'registering' || state === 'authenticating') {
      if (this.lastStatus.kind === 'active') {
        // 已配对会话的 relay 短抖：保持 active（心跳 watchdog 兜底重连）
        return;
      }
      this.emitStatus({ kind: 'starting' });
      return;
    }
    if (state === 'error') {
      this.emitStatus({ kind: 'error', message: 'relay 连接失败（稍后自动重连；也可检查网络后重试）' });
    }
  }

  private emitStatus(status: PairingStatus): void {
    this.lastStatus = status;
    this.options.onStatus(status);
  }

  // ═══════════════ 出向缓冲（断线窗口内不丢响应） ═══════════════

  private sendAppPayload(payload: RelayAppPayload): void {
    if (this.pendingOutbound.length > 0) {
      this.bufferOutbound(payload);
      this.flushPendingOutbound();
      return;
    }
    const result = this.sendToTransport(payload);
    if (result.kind === 'sent') return;
    if (result.kind === 'oversize') {
      this.options.logger.warn('[pairing] dropped oversize app payload', { zcodeType: (payload as { zcode_type?: string }).zcode_type, bytes: result.bytes });
      return;
    }
    this.bufferOutbound(payload);
  }

  private sendToTransport(payload: RelayAppPayload): RelaySendResult {
    return this.transport?.sendPayloadResult(payload) ?? { kind: 'unavailable' };
  }

  private bufferOutbound(payload: RelayAppPayload): void {
    if (this.pendingOutbound.length >= OUTBOUND_BUFFER_LIMIT) {
      const dropped = this.pendingOutbound.length + 1;
      this.pendingOutbound = [];
      this.clearPendingOutboundTimer();
      this.options.logger.warn('[pairing] dropped overflowing outbound payloads', { dropped });
      return;
    }
    this.pendingOutbound.push(payload);
    if (!this.pendingOutboundTimer) {
      this.pendingOutboundTimer = setTimeout(() => {
        this.pendingOutboundTimer = undefined;
        const dropped = this.pendingOutbound.splice(0).length;
        if (dropped > 0) this.options.logger.warn('[pairing] dropped buffered outbound payloads', { dropped });
      }, OUTBOUND_BUFFER_TIMEOUT_MS);
      this.pendingOutboundTimer.unref?.();
    }
  }

  private flushPendingOutbound(): void {
    while (this.pendingOutbound.length > 0) {
      const payload = this.pendingOutbound[0]!;
      const result = this.sendToTransport(payload);
      if (result.kind === 'unavailable') return;
      if (result.kind === 'oversize') {
        this.options.logger.warn('[pairing] dropped oversize buffered payload', { zcodeType: (payload as { zcode_type?: string }).zcode_type, bytes: result.bytes });
      }
      this.pendingOutbound.shift();
    }
    this.clearPendingOutboundTimer();
  }

  private clearPendingOutboundTimer(): void {
    if (this.pendingOutboundTimer) {
      clearTimeout(this.pendingOutboundTimer);
      this.pendingOutboundTimer = undefined;
    }
  }

  // ═══════════════ 快照构造 ═══════════════

  private buildListResult(): RelayWorkspaceListResult {
    const workspaces = this.options.listWorkspaces();
    const tasks = this.options.listTasks();
    return {
      workspaces,
      tasks,
      activeWorkspaceKey: this.mobileViewState?.activeWorkspaceKey ?? (workspaces[0] ? resolveWorkspaceKey(workspaces[0]) : undefined),
      activeTaskId: this.mobileViewState?.activeTaskId,
    };
  }

  private pushWorkspaceListUpdated(): void {
    const result = this.buildListResult();
    const signature = buildListSignature(result);
    if (this.pushedListSignature === signature) return;
    this.pushedListSignature = signature;
    this.sendAppPayload({ zcode_type: 'workspace-list-updated', result });
  }

  // ═══════════════ payload 路由 ═══════════════

  private routePayload(payload: RelayAppPayload): void {
    switch (payload.zcode_type) {
      case 'bootstrap-request': {
        const result = this.buildListResult();
        this.sendAppPayload({
          zcode_type: 'bootstrap-response',
          requestId: payload.requestId,
          success: true,
          result: {
            windowControlSessionId: this.auth?.deviceSid ?? 'unknown',
            desktopAppVersion: this.options.appVersion,
            workspaces: result.workspaces,
            tasks: result.tasks ?? [],
            ...(this.mobileViewState ? { mobileViewState: this.mobileViewState } : {}),
          },
        });
        this.pushedListSignature = buildListSignature(result);
        return;
      }
      case 'workspace-list-request': {
        const result = this.buildListResult();
        this.sendAppPayload({ zcode_type: 'workspace-list-response', requestId: payload.requestId, success: true, result });
        this.pushedListSignature = buildListSignature(result);
        return;
      }
      case 'workspace-bridge-open': {
        void this.respondToBridgeOpen(payload);
        return;
      }
      case 'mobile-view-state-update': {
        this.mobileViewState = payload.viewState;
        return;
      }
      case 'platform-request': {
        // v1 安全降级：Docker/WSL/SSH 枚举与临时附件创建在插件宿主不可用
        this.sendAppPayload({ zcode_type: 'platform-response', requestId: payload.requestId, method: payload.method, success: false, error: 'unsupported in vscode plugin' });
        return;
      }
      case 'workspace-reconnect-request': {
        // 插件侧只有本地工作区，无远端可重连
        this.sendAppPayload({ zcode_type: 'workspace-reconnect-response', requestId: payload.requestId, workspaceKey: payload.workspaceKey, success: false, error: 'unsupported in vscode plugin' });
        return;
      }
      case 'mobile-diagnostic':
      case 'telemetry-report':
        return;
      default:
        return;
    }
  }

  // ═══════════════ bridge 生命周期 ═══════════════

  private disposeBridge(): void {
    const bridge = this.bridge;
    if (!bridge) return;
    this.bridge = null;
    bridge.ack.dispose();
    try {
      bridge.server.dispose();
    } catch {
      // 进程已退出时 dispose 失败不影响主流程
    }
    this.options.logger.info('[pairing] bridge 已释放', { bridgeSessionId: bridge.identity.bridgeSessionId });
  }

  private async respondToBridgeOpen(
    payload: Extract<RelayAppPayload, { zcode_type: 'workspace-bridge-open' }>,
  ): Promise<void> {
    const identity: RelayBridgeIdentity = {
      bridgeSessionId: payload.bridgeSessionId,
      ...(payload.bridgeGeneration !== undefined ? { bridgeGeneration: payload.bridgeGeneration } : {}),
      ...(payload.recoveryId ? { recoveryId: payload.recoveryId } : {}),
    };
    const respondError = (reason: string, error: string) => {
      this.sendAppPayload({
        zcode_type: 'workspace-bridge-error',
        requestId: payload.requestId,
        bridgeSessionId: identity.bridgeSessionId,
        ...(identity.bridgeGeneration !== undefined ? { bridgeGeneration: identity.bridgeGeneration } : {}),
        ...(identity.recoveryId ? { recoveryId: identity.recoveryId } : {}),
        reason,
        error,
      });
    };
    const target = this.options.listWorkspaces().find((w) => resolveWorkspaceKey(w) === payload.workspaceKey);
    if (!target) {
      respondError('workspace-closed', '目标工作区不在当前 VSCode 窗口中。');
      return;
    }

    this.disposeBridge();
    this.options.logger.info('[pairing] 创建 workspace bridge', { bridgeSessionId: identity.bridgeSessionId, workspace: target.workspacePath });

    let server: LocalServerConnection;
    try {
      server = await this.options.spawnServer(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.warn('[pairing] zcode-server 拉起失败', { message });
      respondError('unexpected-error', `本地 zcode-server 启动失败：${message}`);
      return;
    }

    const ack = createAckRelayProtocol({
      ...identity,
      measureFrameBytes: (frame) => this.transport?.measurePayloadBytes(frame) ?? 0,
      sendFrame: (frame) => {
        if (!this.bridge || this.bridge.ack !== ack || !this.bridgeReady(this.bridge)) return false;
        const result = this.sendToTransport(frame);
        if (result.kind === 'oversize') throw new Error('remote.rpcFrame.envelopeTooLarge');
        return result.kind === 'sent';
      },
    });

    const wireServerToRelay: { dispose(): void } = { dispose: () => undefined };
    const disposeServerListener = server.protocol.onMessage((bytes) => ack.protocol.send(bytes));
    const disposeRelayListener = ack.protocol.onMessage((bytes) => server.protocol.send(bytes));
    const disposeDegraded = ack.onDegraded((fault) => {
      const bridge = this.bridge;
      if (!bridge || bridge.ack !== ack || bridge.degraded) return;
      bridge.degraded = true;
      this.options.logger.warn('[pairing] bridge 降级', { bridgeSessionId: identity.bridgeSessionId, reasonCode: fault.reasonCode });
      this.sendAppPayload({
        zcode_type: 'bridge-degraded',
        bridgeSessionId: identity.bridgeSessionId,
        ...(identity.bridgeGeneration !== undefined ? { bridgeGeneration: identity.bridgeGeneration } : {}),
        ...(identity.recoveryId ? { recoveryId: identity.recoveryId } : {}),
        reason: 'rpc-transport-fault',
      });
    });
    wireServerToRelay.dispose = () => {
      disposeServerListener.dispose();
      disposeRelayListener.dispose();
      disposeDegraded.dispose();
    };

    const bridge: BridgeRuntime = { identity, ack, server, readyAnnounced: false, degraded: false, dispose: wireServerToRelay.dispose };
    this.bridge = bridge;

    this.sendAppPayload({
      zcode_type: 'workspace-bridge-ready',
      requestId: payload.requestId,
      bridgeSessionId: identity.bridgeSessionId,
      ...(identity.bridgeGeneration !== undefined ? { bridgeGeneration: identity.bridgeGeneration } : {}),
      ...(identity.recoveryId ? { recoveryId: identity.recoveryId } : {}),
      bridge: {
        bridgeSessionId: identity.bridgeSessionId,
        ...(identity.bridgeGeneration !== undefined ? { bridgeGeneration: identity.bridgeGeneration } : {}),
        ...(identity.recoveryId ? { recoveryId: identity.recoveryId } : {}),
        kind: 'local',
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
        ...(payload.taskId ? { initialTaskId: payload.taskId } : {}),
      },
    });

    const current = this.bridge;
    if (current === bridge && current.identity.bridgeSessionId === payload.bridgeSessionId && current.identity.bridgeGeneration === payload.bridgeGeneration) {
      // ready 必须先进普通 app 传输，才允许 queued raw 帧开闸
      current.readyAnnounced = true;
      current.ack.flushPendingFrames();
    }
  }

  private bridgeReady(bridge: BridgeRuntime): boolean {
    return bridge.readyAnnounced && !bridge.degraded;
  }
}

export { RPC_TRANSPORT_LIMITS };
