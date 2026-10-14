/**
 * [INPUT]: 依赖 vscode（工作区/配置/剪贴板/globalState）、qrcode 的 toString（SVG）、./remote/*（PairingManager/spawnLocalServer）、./environment
 * [OUTPUT]: 对外提供 PairingController（手机配对控制层：常驻装配、二维码 SVG 生成、配置门控、状态缓存与 webview 推送、
 *           zcode-server 资产定位与拉起、globalState 配对身份持久化）
 * [POS]: 根级配对控制层——extension.ts 装配（context.subscriptions 常驻），chatProvider 的 pair-* 消息经它路由；协议编排在 src/remote
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 资产约定：zcode-server.cjs 不随 vsix 分发（体积），按「配置 zcode.serverPath → 默认 ~/.zcode/vscode-remote/zcode-server.cjs」定位；
 * 缺失时配对可用（手机扫码后 bridge-open 报错提示安装），不阻塞 relay 通道。
 * 安全约束：passHash 等价配对口令，只进 globalState 与协议字段，严禁日志。
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as QRCode from 'qrcode';
import type { PairingPanelPayload } from './ui/bridge';
import type { RelayTaskTarget, RelayWorkspaceTarget, StoredPairingAuth } from './remote';
import { PairingManager, spawnLocalServer, type LocalServerConnection, type PairingStatus } from './remote';
import type { ZcodeEnvironment } from './environment';

export const DEFAULT_SERVER_PATH = () => path.join(os.homedir(), '.zcode', 'vscode-remote', 'zcode-server.cjs');
export const DEFAULT_RELAY_WS_URL = 'wss://zcode.z.ai/ws';

/** 跨窗口配对租约：同一设备身份同时只能一端在线，多个 VSCode 窗口靠它仲裁（globalState 实现，TTL 过期自愈） */
export interface PairingLock {
  /** 非强制：租约空闲/过期/属己才成功（autoRestore 用）；强制：直接抢占（手动点击配对的语义） */
  acquire(force?: boolean): boolean;
  /** 心跳维持；发现被其他窗口抢占时回调 onLost（调用方应静默停止配对） */
  startHeartbeat(onLost: () => void): void;
  release(): void;
}

export interface PairingControllerOptions {
  appVersion: string;
  env: () => ZcodeEnvironment;
  relayWsUrl: () => string;
  pairingEnabled: () => boolean;
  serverPath: () => string;
  listWorkspaces: () => RelayWorkspaceTarget[];
  listTasks: () => RelayTaskTarget[];
  /** 配对身份持久化（globalState 适配；deviceSid/passHash 等价配对口令，严禁日志） */
  storage: {
    load(): Promise<StoredPairingAuth | undefined>;
    save(auth: StoredPairingAuth): Promise<void>;
    clear(): Promise<void>;
  };
  /** 跨窗口租约（可选；缺省单窗口行为） */
  lock?: PairingLock;
  /** 面板展示的身份来源标注（宿主侧本地化，如「共享桌面设备身份（…xxxxxx）」） */
  identityLabel?: () => string;
  push: (msg: { kind: 'pair-status'; data: PairingPanelPayload }) => void;
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}

export class PairingController implements vscode.Disposable {
  private manager: PairingManager;
  private lastPanel: PairingPanelPayload | null = null;
  private qrSvgCache = new Map<string, string>();
  private disposed = false;

  constructor(private readonly options: PairingControllerOptions) {
    this.manager = new PairingManager({
      relayWsUrl: options.relayWsUrl(),
      deviceName: `VSCode · ${os.hostname()}`,
      appVersion: options.appVersion,
      spawnServer: (target) => this.spawnServer(target),
      listWorkspaces: () => options.listWorkspaces(),
      listTasks: () => options.listTasks(),
      storage: options.storage,
      onStatus: (status) => void this.handleStatus(status),
      logger: options.logger,
    });
  }

  // ═══════════════ 对外操作（webview 命令与 extension 装配消费） ═══════════════

  /** 常驻自动连接：activate 时若存在持久化配对且开关允许则静默拉起（仅当跨窗口租约空闲——同身份多窗口会互踢） */
  autoRestore(): void {
    if (!this.options.lock?.acquire(false)) return;
    void this.options.storage
      .load()
      .then((stored) => {
        if (stored && !this.disposed && this.options.pairingEnabled()) {
          this.options.lock?.startHeartbeat(() => {
            void this.manager.stop('lease-lost');
          });
          return this.start();
        }
        if (!stored) this.options.lock?.release();
      })
      .catch(() => {
        this.options.lock?.release();
      });
  }

  /** 打开/启动配对：幂等；未启用或环境缺失时以状态消息回报。手动入口=强制抢占租约 */
  async start(): Promise<void> {
    if (this.disposed) return;
    if (!this.options.pairingEnabled()) {
      this.handleStatus({ kind: 'error', message: '手机配对已通过 zcode.remotePairing.enabled 关闭。' });
      return;
    }
    this.options.lock?.acquire(true);
    this.options.lock?.startHeartbeat(() => {
      // 被其他窗口抢占：静默让位（对端面板会接手显示二维码）
      void this.manager.stop('lease-lost');
      this.pushCurrent();
    });
    await this.manager.start().catch((error) => {
      this.options.logger.error('[pairing] start 失败', { message: error instanceof Error ? error.message : String(error) });
      this.handleStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    this.pushCurrent();
  }

  async stop(): Promise<void> {
    this.options.lock?.release();
    await this.manager.stop('webview-stop');
    this.pushCurrent();
  }

  async refresh(): Promise<void> {
    await this.manager.refreshPairing();
    this.pushCurrent();
  }

  async copyLink(url: string): Promise<void> {
    await vscode.env.clipboard.writeText(url);
  }

  /** 工作区/会话快照变化 → 手机端列表刷新 */
  notifySnapshotChanged(): void {
    this.manager.notifySnapshotChanged();
  }

  /** 面板打开时回推缓存状态（常驻连接下即时可显） */
  pushCurrent(): void {
    if (this.lastPanel) this.options.push({ kind: 'pair-status', data: this.lastPanel });
  }

  get currentStatus(): PairingStatus {
    return this.manager.currentStatus;
  }

  dispose(): void {
    this.disposed = true;
    this.options.lock?.release();
    this.manager.dispose();
  }

  // ═══════════════ 内部 ═══════════════

  private async spawnServer(target: RelayWorkspaceTarget): Promise<LocalServerConnection> {
    const env = this.options.env();
    const serverPath = this.options.serverPath();
    if (!fs.existsSync(serverPath)) {
      throw new Error(`未找到 zcode-server（${serverPath}）。请先按文档安装到该路径，或配置 zcode.serverPath。`);
    }
    return spawnLocalServer({
      nodeCommand: env.nodeCommand,
      serverPath,
      cwd: target.workspacePath,
      env: {
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: env.builtinConfigPath,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: env.personalConfigPath,
      },
      clientVersion: this.options.appVersion,
      logger: this.options.logger,
    });
  }

  private async handleStatus(status: PairingStatus): Promise<void> {
    const identity = this.options.identityLabel?.();
    const prev = this.lastPanel;
    let next: PairingPanelPayload;
    if (status.kind === 'waiting' || status.kind === 'active') {
      const qrSvg = await this.qrSvgFor(status.qrUrl);
      next = { status: status.kind, qrSvg, qrUrl: status.qrUrl, ...(identity ? { identity } : {}) };
    } else if (status.kind === 'starting') {
      next = { status: 'starting', ...(identity ? { identity } : {}) };
    } else if (status.kind === 'error') {
      next = { status: 'error', message: status.message, ...(identity ? { identity } : {}) };
    } else {
      next = { status: 'idle' };
    }
    this.lastPanel = next;
    // diff 门：面板内容未变不推（状态机抖动/风暴期防闪烁的关键）
    if (prev && prev.status === next.status && prev.qrUrl === next.qrUrl && prev.message === next.message && prev.qrSvg === next.qrSvg) return;
    this.options.push({ kind: 'pair-status', data: next });
  }

  private async qrSvgFor(url: string): Promise<string | undefined> {
    const cached = this.qrSvgCache.get(url);
    if (cached) return cached;
    try {
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 208 });
      if (this.qrSvgCache.size > 8) this.qrSvgCache.clear(); // 刷新配对累积的旧 URL 不长期持有
      this.qrSvgCache.set(url, svg);
      return svg;
    } catch (error) {
      this.options.logger.warn('[pairing] 二维码生成失败', { message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }
}
