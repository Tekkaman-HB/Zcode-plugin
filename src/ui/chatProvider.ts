/**
 * [INPUT]: 依赖 vscode，消费 ../sessionController、./bridge、../environment、../account
 * [OUTPUT]: 对外提供 ChatViewProvider（右侧栏聊天视图宿主）
 * [POS]: ui 的聊天视图提供者，extension.ts 注册；与 webview/main.ts 通过 bridge 契约通信
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AttachmentRef, DirEntry, FromWebviewMessage, ToWebviewMessage } from './bridge';
import type { SessionController } from '../sessionController';
import type { ZcodeServer } from '../serverManager';
import type { ZcodeEnvironment } from '../environment';
import type { AccountStatus } from '../account';
import type { SessionMode } from '../protocol/types';
import type { Locale } from '../i18n';

/** 常见扩展名 → MIME（附件内联用） */
const ATTACH_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  csv: 'text/csv', html: 'text/html', svg: 'image/svg+xml', mp4: 'video/mp4', mp3: 'audio/mpeg'
};

export interface ChatViewHost {
  locale: Locale;
  extUri: vscode.Uri;
  env: ZcodeEnvironment;
  server: () => ZcodeServer | null;
  controller: () => SessionController | null;
  workspacePath: () => string;
  defaultMode: () => SessionMode;
  /** webview 就绪：预建草稿会话，让模型/模式/思考强度立即可用 */
  onWebviewReady: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onOpenDesktop: () => void;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'zcode.chat';
  private view: vscode.WebviewView | null = null;
  private locale: Locale;
  private host: ChatViewHost;
  private lastAccount: AccountStatus | null = null;

  constructor(host: ChatViewHost) {
    this.host = host;
    this.locale = host.locale;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const extRoot = this.host.extUri;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [extRoot]
    };
    view.webview.html = this.html(view.webview, extRoot);
    view.webview.onDidReceiveMessage((msg: FromWebviewMessage) => void this.onMessage(msg));
  }

  post(msg: ToWebviewMessage): void {
    void this.view?.webview.postMessage(msg);
  }

  /** webview 就绪后注入引导载荷 */
  bootstrap(): void {
    const env = this.host.env;
    this.post({
      kind: 'bootstrap',
      data: {
        locale: this.locale,
        workspacePath: this.host.workspacePath(),
        environmentOk: env.cliExists && env.builtinExists && env.builtinRevision !== null,
        environmentDetail: !env.cliExists ? env.cliPath : undefined,
        account: this.lastAccount,
        serverState: this.host.server()?.currentState ?? 'stopped',
        defaultMode: this.host.defaultMode()
      }
    });
  }

  setAccount(status: AccountStatus | null): void {
    this.lastAccount = status;
    this.post({ kind: 'account', data: status });
  }

  private async onMessage(msg: FromWebviewMessage): Promise<void> {
    const controller = this.host.controller();
    const server = this.host.server();
    try {
      switch (msg.kind) {
        case 'ready':
          this.bootstrap();
          // webview 重载（reload/内存回收后 resolveWebviewView 重新注入 HTML）状态清零：
          // 重投宿主侧留存的未答交互卡，否则 CLI 的 reannounce 兜不住跨重载投递，回合永久悬挂
          this.host.controller()?.redeliverPendingInteractions();
          this.host.onWebviewReady();
          break;
        case 'send': {
          if (!server || !controller) return;
          if (!controller.sessionId) {
            await controller.newSession(this.host.workspacePath(), this.host.defaultMode());
          }
          await controller.send(msg.content, msg.attachments);
          break;
        }
        case 'attach-pick': {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFolders: false,
            openLabel: 'Attach'
          });
          // 协议走 localPath（probe 实证 dataBase64 不送达）——只传路径，不过桥大文件
          const attachments: AttachmentRef[] = [];
          for (const uri of picked ?? []) {
            try {
              const stat = await vscode.workspace.fs.stat(uri);
              if (stat.size > 50 * 1024 * 1024) continue;
              attachments.push({
                name: uri.path.split('/').pop() ?? uri.fsPath,
                path: uri.fsPath,
                mime: ATTACH_MIME[uri.path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream',
                size: stat.size
              });
            } catch {
              /* 单文件 stat 失败跳过 */
            }
          }
          this.post({ kind: 'attachments-picked', data: { attachments } });
          break;
        }
        case 'save-image': {
          // 粘贴图无路径：宿主落盘临时文件换 localPath（图片必须走文件通道）
          const m2 = /^data:([^;]+);base64,(.+)$/.exec(msg.dataUrl);
          if (!m2) break;
          const ext = (m2[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
          const dir = path.join(os.tmpdir(), 'zcode-vscode-attachments');
          await fs.mkdir(dir, { recursive: true });
          const name = `${msg.name.replace(/\.[^.]+$/, '') || 'image'}.${ext}`;
          const file = path.join(dir, name);
          await fs.writeFile(file, Buffer.from(m2[2], 'base64'));
          this.post({ kind: 'image-saved', data: { path: file, name, mime: m2[1] } });
          break;
        }
        case 'list-files': {
          const entries = await this.listDir(msg.dir ?? '');
          this.post({ kind: 'files-list', data: { dir: msg.dir ?? '', entries } });
          break;
        }
        case 'remove-queue-item':
          controller?.removeQueueItem(msg.id);
          break;
        case 'prioritize-queue-item':
          await controller?.prioritizeQueueItem(msg.id);
          break;
        case 'mcp-servers': {
          await this.host.server()?.start();
          const servers = await controller?.fetchMcpServers();
          if (servers) this.post({ kind: 'mcp-servers', data: { running: true, servers } });
          break;
        }
        case 'stop':
          await controller?.stop();
          break;
        case 'new-session':
          await controller?.newSession(this.host.workspacePath(), (msg.mode as SessionMode) ?? this.host.defaultMode());
          break;
        case 'resume':
          await controller?.resumeSession(msg.sessionId);
          break;
        case 'list-sessions': {
          await this.host.server()?.start();
          const result = await controller?.listSessions(this.host.workspacePath());
          if (result) {
            this.post({ kind: 'sessions-list', data: { sessions: result.sessions.map((s) => ({ sessionId: s.sessionId, title: s.title, updatedAt: s.updatedAt, mode: s.mode, status: s.status, workspacePath: s.workspace.workspacePath })) } });
          }
          break;
        }
        case 'set-model': {
          if (!controller) break;
          if (!controller.sessionId) {
            // 会话未就绪（首次进入）：携所选模型建草稿会话，选择立即落定
            await controller.newSession(this.host.workspacePath(), this.host.defaultMode(), {
              providerId: msg.providerId,
              modelId: msg.modelId,
              ...(msg.reasoningLevel ? { options: { reasoningLevel: msg.reasoningLevel } } : {})
            });
            break;
          }
          await controller.setModel(msg.providerId, msg.modelId, msg.reasoningLevel);
          break;
        }
        case 'set-mode': {
          if (!controller) break;
          if (!controller.sessionId) {
            // 会话未就绪：以所选模式建草稿会话
            await controller.newSession(this.host.workspacePath(), msg.mode as SessionMode);
            break;
          }
          await controller.setMode(msg.mode as SessionMode);
          break;
        }
        case 'permission-response':
          controller?.respondPermission(msg.requestId, msg.response);
          break;
        case 'user-input-response':
          controller?.respondUserInput(msg.requestId, msg.response);
          break;
        case 'login':
          this.host.onLogin();
          break;
        case 'logout':
          this.host.onLogout();
          break;
        case 'retry-server':
          await server?.start();
          break;
        case 'refresh-messages':
          await controller?.refreshMessages();
          break;
        case 'open-in-desktop':
          this.host.onOpenDesktop();
          break;
        case 'open-preview': {
          // 附件预览：直接回发 webview（其 CSP img-src data: 已允许，lightbox 自渲染）
          this.post({ kind: 'show-preview', data: { name: msg.name, mime: msg.mime ?? '', dataUrl: msg.dataUrl ?? '' } });
          break;
        }
      }
    } catch (e) {
      this.post({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 按相对目录列举（@ 引用弹层）：隐藏项与 node_modules 排除，文件夹优先排序 */
  private async listDir(rel: string): Promise<DirEntry[]> {
    const ws = this.host.workspacePath();
    if (!ws) return [];
    const abs = rel ? vscode.Uri.joinPath(vscode.Uri.file(ws), rel) : vscode.Uri.file(ws);
    let items: [string, vscode.FileType][];
    try {
      items = await vscode.workspace.fs.readDirectory(abs);
    } catch {
      return [];
    }
    return items
      .filter(([name]) => !name.startsWith('.') && name !== 'node_modules' && name !== '__pycache__')
      .map(([name, type]) => ({ name, kind: type === vscode.FileType.Directory ? 'dir' as const : 'file' as const }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  }

  private html(webview: vscode.Webview, extRoot: vscode.Uri): string {
    const nonce = Math.random().toString(36).slice(2);
    // 资源 URI 带构建指纹（styles.css mtime）：webview 的磁盘缓存按 URL 命中，URI 不变则
    // 新 CSS 永远到不了页面（0.5.x 实际事故：上下文弹层新样式全部隐形）——每次构建必失效
    const ver = String(fsSync.statSync(path.join(extRoot.fsPath, 'out', 'webview', 'styles.css')).mtimeMs);
    const asset = (p: string) => `${webview.asWebviewUri(vscode.Uri.joinPath(extRoot, p))}?v=${ver}`;
    const script = asset('out/webview/main.js');
    const styles = asset('out/webview/styles.css');
    return /* html */ `<!DOCTYPE html>
<html lang="${this.locale}">
<head>
<meta charset="UTF-8">
<!-- style-src 必须带 'unsafe-inline'：h() 以 setAttribute('style',...) 写分段宽度/来源色，
     无它则 CSP 静默剥离全部 style 属性（CSSOM el.style.xxx 不受管，故弹层定位照常——半好半坏最难排查） -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styles}">
<title>ZCode</title>
</head>
<!-- data-logo 注入官方原图 URI（media/zcode-icon.png）：webview 层禁 import vscode，
     asWebviewUri 只能宿主完成，icons.ts zLogoEl 从这里取 src -->
<body data-logo="${asset('media/zcode-icon.png')}">
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
