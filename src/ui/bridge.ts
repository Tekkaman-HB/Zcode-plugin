/**
 * [INPUT]: 无运行时依赖，消费 ../protocol/types 的协议类型
 * [OUTPUT]: 对外提供 ToWebviewMessage / FromWebviewMessage（扩展↔webview 消息契约）
 * [POS]: ui 的桥接类型层，extension 侧与 webview 侧共同消费，保证两端契约同构
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type {
  SessionMessage,
  SessionInfo,
  SessionSettings,
  SessionProjection,
  SlashCommand,
  SessionEvent,
  PermissionRequestParams,
  PermissionResponse,
  UserInputRequestParams,
  UserInputResponse
} from '../protocol/types';
import type { ServerState } from '../serverManager';
import type { AccountStatus } from '../account';

// ═══════════════ 扩展 → webview ═══════════════

export interface BootstrapPayload {
  locale: 'zh-CN' | 'en-US';
  workspacePath: string;
  environmentOk: boolean;
  environmentDetail?: string;
  account: AccountStatus | null;
  serverState: ServerState;
  /** 新会话默认权限模式（会话就绪前 chips 显示它） */
  defaultMode: string;
}

export interface SessionSnapshotPayload {
  session: SessionInfo;
  settings: SessionSettings;
  projection: SessionProjection;
  messages: SessionMessage[];
  slashCommands: SlashCommand[];
}

export interface AttachmentRef {
  name: string;
  /** 附件落盘路径（协议 localPath 的数据源——图片必须走文件，dataBase64 不送达） */
  path: string;
  mime?: string;
  size?: number;
  /** 仅 webview 内存：缩略图/预览用，不进发送载荷 */
  dataUrl?: string;
}

/** 乐观渲染的用户消息 */
export interface OptimisticUser {
  id: string;
  text: string;
  attachments?: { name: string }[];
}

/** @ 引用浏览的目录条目 */
export interface DirEntry {
  name: string;
  kind: 'dir' | 'file';
}

export interface SessionsListPayload {
  sessions: {
    sessionId: string;
    title: string;
    updatedAt: number;
    mode: string;
    status: string;
    workspacePath: string;
  }[];
}

export type ToWebviewMessage =
  | { kind: 'bootstrap'; data: BootstrapPayload }
  | { kind: 'server-state'; state: ServerState; detail?: string }
  | { kind: 'account'; data: AccountStatus | null }
  | { kind: 'session-snapshot'; data: SessionSnapshotPayload }
  | { kind: 'session-closed' }
  | { kind: 'session-event'; data: SessionEvent }
  | { kind: 'state-updated'; data: { patch: Record<string, unknown>; revision: number; reason?: string } }
  | { kind: 'permission-request'; data: PermissionRequestParams }
  | { kind: 'user-input-request'; data: UserInputRequestParams }
  | { kind: 'sessions-list'; data: SessionsListPayload }
  | { kind: 'messages'; data: { messages: SessionMessage[] } }
  | { kind: 'mcp-progress'; data: { started: number; done: boolean; configuredCount?: number; connectedCount?: number; failedCount?: number; servers?: string[]; crashed?: string[] } }
  | { kind: 'usage'; data: { range: string; totalTokens: number; inputTokens: number; outputTokens: number; modelCount: number } }
  | { kind: 'queued-update'; data: { queued: number; items?: { id: string; content: string }[] } }
  | { kind: 'optimistic-user'; data: OptimisticUser }
  | { kind: 'mcp-servers'; data: { running: boolean; servers: { name: string; pid: number; source: string }[] } }
  | { kind: 'attachments-picked'; data: { attachments: AttachmentRef[] } }
  | { kind: 'files-list'; data: { dir: string; entries: DirEntry[] } }
  | { kind: 'show-preview'; data: { name: string; mime: string; dataUrl: string } }
  | { kind: 'image-saved'; data: { path: string; name: string; mime: string } }
  | { kind: 'error'; message: string };

// ═══════════════ webview → 扩展 ═══════════════

export type FromWebviewMessage =
  | { kind: 'send'; content: string; attachments?: AttachmentRef[] }
  | { kind: 'attach-pick' }
  | { kind: 'save-image'; dataUrl: string; name: string }
  | { kind: 'list-files'; dir?: string }
  | { kind: 'mcp-servers' }
  | { kind: 'remove-queue-item'; id: string }
  | { kind: 'prioritize-queue-item'; id: string }
  | { kind: 'stop' }
  | { kind: 'new-session'; mode?: string }
  | { kind: 'resume'; sessionId: string }
  | { kind: 'list-sessions' }
  | { kind: 'set-model'; providerId: string; modelId: string; reasoningLevel?: string }
  | { kind: 'set-mode'; mode: string }
  | { kind: 'permission-response'; requestId: string; response: PermissionResponse }
  | { kind: 'user-input-response'; requestId: string; response: UserInputResponse }
  | { kind: 'login' }
  | { kind: 'logout' }
  | { kind: 'retry-server' }
  | { kind: 'open-in-desktop' }
  | { kind: 'open-preview'; name: string; mime?: string; dataUrl?: string }
  | { kind: 'refresh-messages' }
  | { kind: 'ready' };
