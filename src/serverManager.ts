/**
 * [INPUT]: 依赖 node:child_process，消费 ./protocol/rpc、./protocol/types、./environment、./account
 * [OUTPUT]: 对外提供 ZcodeServer（单工作区 app-server 守护）与反向请求路由
 * [POS]: 进程管理层——spawn/推送账户/重启退避，被 sessionController.ts 消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { RpcClient } from './protocol/rpc';
import type {
  PermissionRequestParams,
  RuntimePrefsResult,
  UserInputRequestParams,
  UserInputResponse,
  AccountSnapshot
} from './protocol/types';
import type { ZcodeEnvironment } from './environment';
import { buildAccountSnapshot, watchCredentials, type CredentialsWatcher, type AccountStatus } from './account';
import { decryptCredentials, getProviderApiKey } from './credentials';

export type ServerState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface ZcodeServerCallbacks {
  onNotification: (method: string, params: unknown) => void;
  onPermissionRequest: (req: PermissionRequestParams, respond: (result: unknown) => void) => void;
  onUserInputRequest: (req: UserInputRequestParams, respond: (result: UserInputResponse) => void) => void;
  onStateChange: (state: ServerState, detail?: string) => void;
  onAccountStatus: (status: AccountStatus) => void;
}

const MAX_RESTART_ATTEMPTS = 3;

export class ZcodeServer {
  readonly workspacePath: string;
  private env: ZcodeEnvironment;
  private cbs: ZcodeServerCallbacks;
  private rpc: RpcClient | null = null;
  private state: ServerState = 'stopped';
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private credentialsWatcher: CredentialsWatcher | undefined;
  private disposed = false;
  private startSeq = 0;
  accountSnapshot: AccountSnapshot | null = null;

  constructor(workspacePath: string, env: ZcodeEnvironment, cbs: ZcodeServerCallbacks) {
    this.workspacePath = workspacePath;
    this.env = env;
    this.cbs = cbs;
  }

  get currentState(): ServerState {
    return this.state;
  }

  /** 幂等启动：spawn → 推送账户 → ready */
  async start(): Promise<void> {
    if (this.disposed) throw new Error('server disposed');
    if (this.state === 'ready' || this.state === 'starting') return;
    this.setState('starting');
    const seq = ++this.startSeq;

    const rpc = RpcClient.spawn({
      command: this.env.nodeCommand,
      args: [this.env.cliPath, 'app-server', '--stdio'],
      env: {
        ...process.env,
        ...this.env.nodeExtraEnv,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: this.env.builtinConfigPath,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: this.env.personalConfigPath
      } as Record<string, string>,
      cwd: this.workspacePath
    });
    this.rpc = rpc;
    rpc.reverseRouter = (method, params) => this.routeReverse(method, params);
    rpc.on('notification', (n) => this.cbs.onNotification(n.method, n.params));
    rpc.on('stderr', () => {
      // CLI stderr 是诊断噪声（dotenvx 提示、Built-in 刷新日志等）：
      // 曾因把它当作 starting 事件导致横幅常驻 + 会话被误清，禁止参与状态机
    });

    void rpc.exitPromise.then(({ code, signal }) => {
      if (this.disposed || seq !== this.startSeq) return;
      this.rpc = null;
      this.setState('failed', `app-server 退出 (code=${code} signal=${signal})`);
      this.scheduleRestart();
    });

    // 凭据变化 → 重新推送账户（登录/登出即时生效）
    this.credentialsWatcher?.stop();
    this.credentialsWatcher = watchCredentials(this.env.credentialsPath, () => void this.repushAccount());

    await this.repushAccount();
    if (seq !== this.startSeq || this.disposed) return;
    this.restartAttempts = 0;
    this.setState('ready');
  }

  /** 依据最新桌面端文件重建并推送账户快照 */
  async repushAccount(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;
    const built = buildAccountSnapshot(
      this.env.builtinConfigPath,
      this.env.credentialsPath,
      this.env.settingPath,
      this.env.builtinRevision
    );
    this.accountSnapshot = built.snapshot;
    this.cbs.onAccountStatus(built.status);
    if (!built.snapshot) return;
    try {
      await rpc.request('provider/updateAccountConfig', built.snapshot, 30_000);
    } catch {
      /* 推送失败静默：进程仍健在，watchCredentials 变化时会自动重推 */
    }
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.rpc) return Promise.reject(new Error('app-server 未运行'));
    return this.rpc.request<T>(method, params, timeoutMs);
  }

  private setState(s: ServerState, detail?: string): void {
    this.state = s;
    this.cbs.onStateChange(s, detail);
  }

  private scheduleRestart(): void {
    if (this.disposed) return;
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.setState('failed', '多次重启失败，请手动重试');
      return;
    }
    const delay = Math.min(1000 * 2 ** this.restartAttempts, 8000);
    this.restartAttempts++;
    this.restartTimer = setTimeout(() => {
      void this.start().catch(() => {
        /* onStateChange 已上报 */
      });
    }, delay);
    this.restartTimer.unref();
  }

  /** 服务端反向请求路由 */
  private routeReverse(method: string, params: unknown): unknown {
    switch (method) {
      case 'session/requestRuntimePreferences': {
        const p = params as { scope?: string };
        const base: RuntimePrefsResult = {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          // 桌面端默认开启但靠倒计时 UI 兜底（autoResolution.deadlineAt 走 v4 投影，插件拿不到）；
          // 插件无倒计时数据源，开了会在用户作答中途静默收卡——必须关
          askUserQuestionAutoResolutionEnabled: false,
          modelContextBudgetStrategy: 'preflight-v1'
        };
        if (p?.scope === 'user-execution') {
          // integratedTerminalShell 是判别联合：auto | {mode:'shell', dialect:'cmd'|'git-bash', ...}（后者仅 Windows）
          return { ...base, integratedTerminalShell: { mode: 'auto' } };
        }
        return base;
      }
      case 'interaction/requestPermission': {
        const req = params as PermissionRequestParams;
        return new Promise((resolve) => {
          this.cbs.onPermissionRequest(req, resolve);
        });
      }
      case 'interaction/requestUserInput': {
        const req = params as UserInputRequestParams;
        return new Promise((resolve) => {
          this.cbs.onUserInputRequest(req, (result) => resolve(result));
        });
      }
      case 'interaction/requestProviderRuntimeHeaders': {
        // CLI 在每次模型请求前向宿主索取认证（桌面端由其账户服务应答）。
        // 应答契约：{headersApplied:true, requestAuth:{apiKey}} | {headersApplied:false, errorMessage}
        const req = params as { providerId?: string; modelSelection?: { providerId?: string } };
        const providerId = req.providerId ?? req.modelSelection?.providerId;
        if (!providerId) {
          return { headersApplied: false, errorMessage: 'unknown provider' };
        }
        const creds = decryptCredentials(this.env.credentialsPath);
        const apiKey = creds ? getProviderApiKey(creds, providerId) : null;
        if (!apiKey) {
          return { headersApplied: false, errorMessage: `no credential for ${providerId}` };
        }
        return { headersApplied: true, requestAuth: { apiKey } };
      }
      case 'interaction/requestOfficialMcpAuthHeaders':
        // 官方 MCP 站点 OAuth 头：v1 不代理，返回失败让 CLI 走降级路径
        return { ok: false, reason: 'unsupported' };
      default:
        // MCP 回调（sampling/elicitation/roots 等）当前不代理给 UI，返回不支持
        throw new Error(`reverse request not supported: ${method}`);
      }
  }

  dispose(): void {
    this.disposed = true;
    this.startSeq++;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.credentialsWatcher?.stop();
    this.rpc?.kill();
    this.rpc = null;
    this.setState('stopped');
  }
}
