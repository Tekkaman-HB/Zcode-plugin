/**
 * [INPUT]: 依赖 vscode，消费 ./environment / ./account / ./serverManager / ./sessionController / ./ui/* / ./i18n / ./quotaUsage / ./pairingController
 * [OUTPUT]: 对外提供 activate / deactivate（插件生命周期入口）
 * [POS]: 激活中枢——装配环境探测、服务守护、会话控制、聊天侧栏视图与手机配对（常驻 relay 通道 + autoRestore）；
 *        globalState 持久化最近使用模式与配对身份；globalStorageUri/session-diffs 持久化会话快照与扩展级只读快照文件系统，装配发送/实时事件/用户保存边界
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import * as vscode from 'vscode';
import { resolveEnvironment } from './environment';
import { ZcodeServer } from './serverManager';
import { SessionController } from './sessionController';
import { ChatViewProvider, type ChatViewHost } from './ui/chatProvider';
import { SessionChanges } from './ui/sessionChanges';
import { SnapshotDocuments } from './ui/snapshotDocuments';
import type { ToWebviewMessage } from './ui/bridge';
import { detectLocale, makeT, type Locale, type StringKey } from './i18n';
import { QuotaMonitor } from './quotaUsage';
import { PairingController, DEFAULT_RELAY_WS_URL, DEFAULT_SERVER_PATH } from './pairingController';
import { readDesktopRelayIdentity, isDesktopRemoteControlActive } from './credentials';
import type { SessionMode } from './protocol/types';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// ═══════════════ 最近使用模式（globalState 跨窗口延续） ═══════════════
const LAST_MODE_KEY = 'zcode.lastMode';
/** 可选模式集合 = 配置 enum；'auto' 为 CLI 内部态（菜单不可选），不持久化 */
const PICKABLE_MODES: ReadonlySet<string> = new Set(['plan', 'build', 'edit', 'yolo']);
/** 手机配对身份（deviceSid/passHash 等价配对口令——严禁日志，仅 globalState 与协议字段） */
const PAIRING_AUTH_KEY = 'zcode.remotePairing.auth';
/** 跨窗口配对租约（同一设备身份同时只能一端在线——多窗口同时配对会互踢闪烁） */
const PAIRING_LEASE_KEY = 'zcode.remotePairing.lease';
const PAIRING_LEASE_TTL_MS = 45_000;
const PAIRING_LEASE_HEARTBEAT_MS = 15_000;

export function activate(context: vscode.ExtensionContext): void {
  const locale = detectLocale();
  const t = makeT(locale);

  const cfg = () => vscode.workspace.getConfiguration('zcode');
  let env = resolveEnvironment({
    appPath: cfg().get<string>('appPath'),
    nodePath: cfg().get<string>('nodePath')
  });

  // ── 工作区（v1 取第一个文件夹） ──
  const workspacePath = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  /** 新会话初始模式：显式配置 zcode.defaultMode 优先；否则延续最近一次使用的模式；否则 build */
  function initialMode(): SessionMode {
    const insp = cfg().inspect<SessionMode>('defaultMode');
    const configured = insp?.globalValue ?? insp?.workspaceValue ?? insp?.workspaceFolderValue;
    if (configured && PICKABLE_MODES.has(configured)) return configured;
    const last = context.globalState.get<string>(LAST_MODE_KEY);
    return last && PICKABLE_MODES.has(last) ? (last as SessionMode) : 'build';
  }

  // ── 服务与会话控制（按工作区路径懒建，文件夹切换时重建） ──
  let server: ZcodeServer | null = null;
  let controller: SessionController | null = null;

  const sessionDiffStorage = vscode.Uri.joinPath(context.globalStorageUri, 'session-diffs').fsPath;
  const sessionChanges = new SessionChanges(sessionDiffStorage);
  context.subscriptions.push(new SnapshotDocuments(sessionDiffStorage), sessionChanges, vscode.workspace.onDidSaveTextDocument(doc => sessionChanges.externalSave(doc.uri.fsPath)));
  const chatProvider = new ChatViewProvider({
    locale,
    sessionChanges,
    extUri: context.extensionUri,
    env,
    server: () => server,
    controller: () => controller,
    workspacePath,
    defaultMode: initialMode,
    onWebviewReady: () => {
      quotaMonitor.refreshNow(); // webview（重）挂载即推缓存+后台刷新，圆环不空窗
      void prepareSession();
    },
    onLogin: () => startLogin(t, locale),
    onLogout: () => void runLogout(t),
    onOpenDesktop: () => openDesktopApp(t),
    onRefreshQuota: () => quotaMonitor.refreshNow(),
    pairing: () => pairing
  } satisfies ChatViewHost);

  // ── 套餐用量轮询（5 小时/每周圆环数据源；provider 跟随当前会话模型——切换套餐
  //    模型后额度换查新 key；失败静默保留旧值，绝不打断主流程） ──
  const quotaMonitor = new QuotaMonitor(
    () => env.credentialsPath,
    () => controller?.currentModelProvider ?? undefined,
    () => env.personalConfigPath,
    (data) => chatProvider.post({ kind: 'quota-usage', data })
  );
  quotaMonitor.start();

  // ── 手机配对（常驻：注册官方 relay 出二维码，手机扫码后经本地 zcode-server 远控工作区；
  //    配对身份持久化于 globalState，重启自动恢复连接——桌面端 restorePreviouslyEnabled 同款） ──
  // 协议契约版本：QR 的 app_version 与 bootstrap 的 desktopAppVersion 会被服务端/页面解析——
  // 低于 3.4.0（WEB_REMOTE_CONTROL_V4_MIN_APP_VERSION）被路由到已下线的 /remote/v3 直接 404（2026-10 实证：
  // app_version=0.5.21 → 404，3.15.1 → 200）。上报移植目标的协议版本；扩展版本不参与远控协议。
  const PROTOCOL_APP_VERSION = '3.15.1';
  // 配对诊断通道：状态轨迹落盘可见（排障定案用；passHash 等凭据严禁进入）
  const pairingChannel = vscode.window.createOutputChannel('Zcode Pairing');
  const fmtPairingArgs = (args: unknown[]): string =>
    args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
  const pairingLogger = {
    info: (...a: unknown[]) => pairingChannel.appendLine(`[${new Date().toISOString()}] ${fmtPairingArgs(a)}`),
    warn: (...a: unknown[]) => pairingChannel.appendLine(`[${new Date().toISOString()}] WARN ${fmtPairingArgs(a)}`),
    error: (...a: unknown[]) => pairingChannel.appendLine(`[${new Date().toISOString()}] ERROR ${fmtPairingArgs(a)}`)
  };

  // ── 跨窗口配对租约：globalState 仲裁（TTL 过期自愈；手动点击=强制抢占，被抢占窗口 ≤15s 内让位） ──
  const leaseOwner = randomUUID();
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  const readLease = () => context.globalState.get<{ owner: string; at: number }>(PAIRING_LEASE_KEY);
  const pairingLock = {
    acquire(force = false): boolean {
      const cur = readLease();
      const mine = cur?.owner === leaseOwner;
      const expired = !cur || Date.now() - cur.at > PAIRING_LEASE_TTL_MS;
      if (!force && !mine && !expired) return false;
      void context.globalState.update(PAIRING_LEASE_KEY, { owner: leaseOwner, at: Date.now() });
      return true;
    },
    startHeartbeat(onLost: () => void): void {
      if (leaseTimer) clearInterval(leaseTimer);
      leaseTimer = setInterval(() => {
        const cur = readLease();
        if (cur && cur.owner !== leaseOwner && Date.now() - cur.at <= PAIRING_LEASE_TTL_MS) {
          if (leaseTimer) clearInterval(leaseTimer);
          leaseTimer = undefined;
          onLost();
          return;
        }
        void context.globalState.update(PAIRING_LEASE_KEY, { owner: leaseOwner, at: Date.now() });
      }, PAIRING_LEASE_HEARTBEAT_MS);
      leaseTimer.unref?.();
    },
    release(): void {
      if (leaseTimer) {
        clearInterval(leaseTimer);
        leaseTimer = undefined;
      }
      if (readLease()?.owner === leaseOwner) void context.globalState.update(PAIRING_LEASE_KEY, undefined);
    }
  };

  const pairing = new PairingController({
    appVersion: PROTOCOL_APP_VERSION,
    env: () => env,
    relayWsUrl: () => cfg().get<string>('remotePairing.relayUrl') || DEFAULT_RELAY_WS_URL,
    pairingEnabled: () => cfg().get<boolean>('remotePairing.enabled') !== false,
    serverPath: () => {
      const configured = cfg().get<string>('serverPath');
      return configured && configured.trim() ? configured : DEFAULT_SERVER_PATH();
    },
    listWorkspaces: () =>
      (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        workspacePath: folder.uri.fsPath,
        label: folder.name,
        kind: 'local' as const
      })),
    listTasks: () => {
      // 任务快照来自会话控制层（session/list），busy 会话隐藏——手机端避免与插件双活跃
      return (controller?.mobileTaskSnapshot() ?? []).filter((task) => task.displayStatus !== 'running');
    },
    storage: {
      // 身份策略（2026-10 实证）：优先复用桌面端 relay 设备身份（同机一体——relay 风控下自注册
      // 新身份无法被手机配对）；桌面身份缺失才自注册并存 globalState。永不清除/覆盖桌面身份。
      load: async () => {
        const desktop = readDesktopRelayIdentity(env.credentialsPath, env.settingPath, env.telemetryStatePath);
        if (desktop) return desktop;
        return context.globalState.get<{ deviceMid: string; deviceSid: string; passHash: string }>(PAIRING_AUTH_KEY);
      },
      save: async (auth) => {
        if (readDesktopRelayIdentity(env.credentialsPath, env.settingPath, env.telemetryStatePath)) return;
        void (await context.globalState.update(PAIRING_AUTH_KEY, auth));
      },
      clear: async () => void (await context.globalState.update(PAIRING_AUTH_KEY, undefined))
    },
    lock: pairingLock,
    identityLabel: () => {
      const desktop = readDesktopRelayIdentity(env.credentialsPath, env.settingPath, env.telemetryStatePath);
      return desktop ? `配对身份：共享桌面设备（…${desktop.deviceSid.slice(-6)}）` : '配对身份：插件自注册';
    },
    // 共享桌面身份 + 桌面端远控开着 → 弹模态确认（取消则不连接并给出行动指引）
    confirmStart: async () => {
      const usesDesktopIdentity = Boolean(readDesktopRelayIdentity(env.credentialsPath, env.settingPath, env.telemetryStatePath));
      if (!usesDesktopIdentity || !isDesktopRemoteControlActive(env.settingPath)) return true;
      const pick = await vscode.window.showWarningMessage(t('pairConflict'), { modal: true }, t('pairConflictContinue'));
      if (pick === t('pairConflictContinue')) return true;
      vscode.window.showInformationMessage(t('pairConflictCancelled'));
      return false;
    },
    // autoRestore 静默让位：桌面端远控开着时不自动抢连接（用户手动点配对才弹确认）
    desktopRemoteActive: () => isDesktopRemoteControlActive(env.settingPath),
    push: (msg) => chatProvider.post(msg),
    logger: pairingLogger
  });
  pairing.autoRestore();

  function ensureCore(): { srv: ZcodeServer; ctl: SessionController } | null {
    const ws = workspacePath();
    if (!ws || !env.cliExists || !env.builtinExists || env.builtinRevision === null) return null;
    if (server && controller && server.workspacePath === ws) return { srv: server, ctl: controller };

    server?.dispose();
    const srv = new ZcodeServer(ws, env, {
      onNotification: (method, params) => controller?.handleNotification(method, params),
      onPermissionRequest: (req, respond) => controller?.handlePermissionRequest(req, respond),
      onUserInputRequest: (req, respond) => controller?.handleUserInputRequest(req, respond),
      onStateChange: (state, detail) => {
        chatProvider.post({ kind: 'server-state', state, detail });
        if (state === 'ready') {
          void prepareSession();
        } else if (state === 'failed' && controller?.sessionId) {
          // 仅真实进程死亡才清会话 UI；重启成功后由 ready 钩子重建草稿会话
          controller.closeSessionUI();
        }
      },
      onAccountStatus: (status) => chatProvider.setAccount(status)
    });
    const ctl = new SessionController(srv, {
      toWebview: (msg: ToWebviewMessage) => chatProvider.post(msg),
      onBeforeSend: async sessionId => {
        const preparing = setTimeout(() => chatProvider.post({ kind: 'session-changes', data: {
          sessionId, status: 'preparing', files: 0, added: 0, deleted: 0, binary: 0
        } }), 200);
        try { await sessionChanges.beginTurn(sessionId, workspacePath()); }
        finally { clearTimeout(preparing); }
      },
      onSendRejected: sessionId => { void sessionChanges.cancelTurn(sessionId); },
      onSessionEvent: event => sessionChanges.observe(event),
      onModeChange: (mode) => {
        if (PICKABLE_MODES.has(mode)) void context.globalState.update(LAST_MODE_KEY, mode);
      },
      onInteractionLog: (line) => srv.logInteraction(line),
      // 手机端任务快照更新 → 经配对通道推送手机首页
      onSnapshotChanged: () => pairing.notifySnapshotChanged()
    });
    server = srv;
    controller = ctl;
    return { srv, ctl };
  }

  async function ensureStarted(): Promise<ZcodeServer | null> {
    const core = ensureCore();
    if (!core) {
      if (!workspacePath()) {
        vscode.window.showWarningMessage(t('noWorkspace'));
      } else if (!env.cliExists || !env.builtinExists) {
        vscode.window.showErrorMessage(t('appMissing', { path: env.appRoot }));
      }
      return null;
    }
    try {
      await core.srv.start();
      return core.srv;
    } catch (e) {
      vscode.window.showErrorMessage(t('serverFailed', { msg: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  }


  /** 预建草稿会话：模型/模式/思考强度 chips 立即有数据，setMode/setModel 立即生效 */
  async function prepareSession(): Promise<void> {
    const core = ensureCore();
    if (!core) return;
    try {
      await core.srv.start();
    } catch {
      return;
    }
    if (!core.ctl.sessionId) {
      await core.ctl.newSession(workspacePath(), initialMode()).catch(() => {
        /* 创建失败不打断 UI，首条消息时会重试 */
      });
    }
  }

  // ── 登录 / 登出（复用 CLI 的共享凭据机制） ──
  function startLogin(t: (k: StringKey, v?: Record<string, string>) => string, _locale: Locale): void {
    const terminal = vscode.window.createTerminal({ name: t('loginTerminalTitle') });
    terminal.show();
    const envVars = [
      `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=${quote(env.builtinConfigPath)}`,
      `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=${quote(env.personalConfigPath)}`
    ];
    terminal.sendText(`${envVars.join(' ')} ${quote(env.nodeCommand)} ${quote(env.cliPath)} login`);
    vscode.window.showInformationMessage(t('loginStarted'));
    // 凭据落盘后由 watchCredentials 自动刷新账户状态
  }

  async function runLogout(t: (k: StringKey, v?: Record<string, string>) => string): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          env.nodeCommand,
          [env.cliPath, 'logout'],
          {
            env: {
              ...process.env,
              ...env.nodeExtraEnv,
              ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: env.builtinConfigPath,
              ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: env.personalConfigPath
            },
            windowsHide: true
          }
        );
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        child.once('error', reject);
      });
      vscode.window.showInformationMessage(t('logoutDone'));
    } catch (e) {
      vscode.window.showErrorMessage(t('logoutFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  }

  function openDesktopApp(t: (k: StringKey, v?: Record<string, string>) => string): void {
    const cmd = process.platform === 'darwin' ? 'open' : undefined;
    if (!cmd || !env.appRoot) {
      vscode.window.showErrorMessage(t('openDesktopFailed', { msg: env.appRoot }));
      return;
    }
    const child = spawn(cmd, [env.appRoot], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }

  function quote(s: string): string {
    return `"${s.replace(/"/g, '\\"')}"`;
  }

  // ── 注册 ──
  context.subscriptions.push(
    quotaMonitor,
    pairing,
    pairingChannel,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatProvider, { webviewOptions: { retainContextWhenHidden: true } }),

    vscode.commands.registerCommand('zcode.sidebar.open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.zcode-sidebar');
      await ensureStarted();
    }),
    vscode.commands.registerCommand('zcode.newSession', async () => {
      const srv = await ensureStarted();
      if (!srv) return;
      await controller?.newSession(workspacePath(), initialMode());
    }),
    vscode.commands.registerCommand('zcode.stop', () => void controller?.stop()),
    vscode.commands.registerCommand('zcode.login', () => startLogin(t, locale)),
    vscode.commands.registerCommand('zcode.logout', () => void runLogout(t)),
    vscode.commands.registerCommand('zcode.openInDesktopApp', () => openDesktopApp(t)),
    vscode.commands.registerCommand('zcode.pairPhone', () => void pairing.start()),

    // 文件夹变化 → 重建核心 + 手机端工作区快照刷新
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      server?.dispose();
      server = null;
      controller = null;
      chatProvider.post({ kind: 'session-closed' });
      pairing.notifySnapshotChanged();
      void ensureStarted();
    }),
    // 配置变化 → 重探测环境并重启
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('zcode')) return;
      env = resolveEnvironment({
        appPath: cfg().get<string>('appPath'),
        nodePath: cfg().get<string>('nodePath')
      });
      server?.dispose();
      server = null;
      controller = null;
      void ensureStarted();
    })
  );

  // 首个视图解析时自动拉起服务（延迟，避免无谓占用）
  setTimeout(() => {
    if (workspacePath()) void ensureStarted();
  }, 1000).unref?.();
}

export function deactivate(): void {
  /* server 由 subscriptions dispose 链回收 */
}
