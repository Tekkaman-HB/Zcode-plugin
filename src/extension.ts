/**
 * [INPUT]: 依赖 vscode，消费 ./environment / ./account / ./serverManager / ./sessionController / ./ui/* / ./i18n
 * [OUTPUT]: 对外提供 activate / deactivate（插件生命周期入口）
 * [POS]: 激活中枢——装配环境探测、服务守护、会话控制与聊天侧栏视图
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import * as vscode from 'vscode';
import { resolveEnvironment } from './environment';
import { ZcodeServer } from './serverManager';
import { SessionController } from './sessionController';
import { ChatViewProvider, type ChatViewHost } from './ui/chatProvider';
import type { ToWebviewMessage } from './ui/bridge';
import { detectLocale, makeT, type Locale, type StringKey } from './i18n';
import type { SessionMode } from './protocol/types';
import { spawn } from 'node:child_process';

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

  // ── 服务与会话控制（按工作区路径懒建，文件夹切换时重建） ──
  let server: ZcodeServer | null = null;
  let controller: SessionController | null = null;

  const chatProvider = new ChatViewProvider({
    locale,
    extUri: context.extensionUri,
    env,
    server: () => server,
    controller: () => controller,
    workspacePath,
    defaultMode: () => cfg().get<SessionMode>('defaultMode') ?? 'build',
    onWebviewReady: () => void prepareSession(),
    onLogin: () => startLogin(t, locale),
    onLogout: () => void runLogout(t),
    onOpenDesktop: () => openDesktopApp(t)
  } satisfies ChatViewHost);

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
      toWebview: (msg: ToWebviewMessage) => chatProvider.post(msg)
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
      await core.ctl.newSession(workspacePath(), cfg().get<SessionMode>('defaultMode') ?? 'build').catch(() => {
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
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatProvider, { webviewOptions: { retainContextWhenHidden: true } }),

    vscode.commands.registerCommand('zcode.sidebar.open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.zcode-sidebar');
      await ensureStarted();
    }),
    vscode.commands.registerCommand('zcode.newSession', async () => {
      const srv = await ensureStarted();
      if (!srv) return;
      await controller?.newSession(workspacePath(), cfg().get<SessionMode>('defaultMode') ?? 'build');
    }),
    vscode.commands.registerCommand('zcode.stop', () => void controller?.stop()),
    vscode.commands.registerCommand('zcode.login', () => startLogin(t, locale)),
    vscode.commands.registerCommand('zcode.logout', () => void runLogout(t)),
    vscode.commands.registerCommand('zcode.openInDesktopApp', () => openDesktopApp(t)),

    // 文件夹变化 → 重建核心
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      server?.dispose();
      server = null;
      controller = null;
      chatProvider.post({ kind: 'session-closed' });
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
