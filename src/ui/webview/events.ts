/**
 * [INPUT]: 消费 ../../protocol/types、../bridge 的 FromWebviewMessage、./interaction 的 InteractionDraft、./i18n 的 Translate、./format 的 extractContentTexts
 * [OUTPUT]: 对外提供 ChatSessionState/MutableSessionMessage 状态形状、EventHost 接口、applySessionEvent()（session/event → 状态机）与 extractMessage/normalizeMessageId/extractToolResultText 适配工具（后者内容块感知：MCP 块数组还原多行文本，兜底 pretty JSON）
 * [POS]: webview 的协议事件适配层——宽容解析事件信封并驱动宿主状态；chat.ts 的 onSessionEvent 委托至此
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type {
  MessagePart,
  SessionSettings,
  SessionProjection,
  SlashCommand,
  SessionEvent,
  PermissionRequestParams,
  UserInputRequestParams,
  ToolPart
} from '../../protocol/types';
import type { FromWebviewMessage } from '../bridge';
import type { InteractionDraft } from './interaction';
import type { Translate } from './i18n';
import { extractContentTexts } from './format';

/** ChatApp 持有的会话状态形状（chat.ts / menus.ts / events.ts 共享） */
export type ChatSessionState = {
  info: { title?: string; sessionId: string };
  settings: SessionSettings;
  projection: SessionProjection;
  slashCommands: SlashCommand[];
};

export interface MutableSessionMessage {
  info: { role: string; messageId?: string; [k: string]: unknown };
  parts: MessagePart[];
}

/** applySessionEvent 对宿主（ChatApp）的最小访问面 */
export interface EventHost {
  t: Translate;
  titleEl: HTMLElement;
  messagesEl: HTMLElement;
  ctxRingBtn: HTMLElement;
  session: ChatSessionState | null;
  messages: Map<string, MutableSessionMessage>;
  dirty: Set<string>;
  currentAssistantId: string | null;
  ctxBreakdown: { source: string; chars: number }[] | null;
  setCtxBreakdown(items: { source: string; chars: number }[]): void;
  saveCtxSnapshot(): void;
  pendingPermissions: Map<string, PermissionRequestParams>;
  pendingUserInputs: Map<string, UserInputRequestParams>;
  ixDrafts: Map<string, InteractionDraft>;
  post(msg: FromWebviewMessage): void;
  scheduleFlush(): void;
  markDirtyPermissions(): void;
  renderStatus(): void;
  renderContextRing(): void;
  isOpenFor(anchor: HTMLElement): boolean;
  toggleContextMenu(refresh?: boolean): void;
  showError(message: string): void;
}

// ═══════════════ 事件适配（宽容解析） ═══════════════
// 信封结构：{type, payload:{...}}；旧路径（无 payload）按根级字段兜底

export function applySessionEvent(host: EventHost, ev: SessionEvent): void {
  const p = ((ev as unknown as { payload?: Record<string, unknown> }).payload ?? ev) as Record<string, unknown>;
  switch (ev.type) {
    case 'model.streaming': {
      const kind = String(p.kind ?? '');
      const mid = String(p.assistantMessageId ?? ev.messageId ?? streamMessageId(host));
      const delta = typeof p.delta === 'string' ? p.delta : '';
      const partId = String(p.partId ?? '');
      if (kind === 'text_delta' && delta) {
        appendToStreamPart(host, mid, partId || `text-${mid}`, 'text', delta);
      } else if (kind === 'reasoning_delta' && delta) {
        appendToStreamPart(host, mid, partId || `reasoning-${mid}`, 'reasoning', delta);
      } else if (kind === 'text_start' || kind === 'reasoning_start' || kind === 'start') {
        // 思考开始的瞬间就要有占位动效：只建消息不触发渲染的话，占位要等第一个 delta 才出现
        ensureMessage(host, mid, 'assistant');
        host.dirty.add(mid);
        host.scheduleFlush();
      }
      break;
    }
    case 'tool.updated': {
      const kind = String(p.kind ?? '');
      const toolCallId = String(p.toolCallId ?? '');
      if (!toolCallId) break;
      const existing = findToolPart(host, toolCallId);
      const toolName = String(p.toolName ?? (existing && (existing as unknown as { toolName?: string }).toolName) ?? 'tool');
      const mid = host.currentAssistantId ?? `tools-${ev.turnId ?? 'current'}`;
      const msg = ensureMessage(host, mid, 'assistant');
      let part = msg.parts.find((x) => x.type === 'tool' && (x as { callId?: string }).callId === toolCallId) as ToolPart | undefined;
      if (!part) {
        part = {
          type: 'tool',
          partId: `tool-${toolCallId}`,
          callId: toolCallId,
          messageId: mid,
          sessionId: '',
          tool: toolName,
          state: { status: 'pending', input: p.input }
        } as unknown as ToolPart;
        msg.parts.push(part);
      }
      const st = part.state as Record<string, unknown>;
      if (p.input !== undefined) st.input = p.input;
      if (typeof p.description === 'string') st.title = p.description;
      switch (kind) {
        case 'scheduled':
          st.status = 'pending';
          // tool.updated 不带 input（probe-diff 实证）：拉权威消息取 Edit/Write 的 old/new_string
          host.post({ kind: 'refresh-messages' });
          break;
        case 'result': {
          st.status = 'completed';
          host.post({ kind: 'refresh-messages' });
          const result = p.result as Record<string, unknown> | undefined;
          const output = extractToolResultText(result);
          if (output) st.output = output;
          if (result && typeof result.title === 'string') st.title = result.title;
          break;
        }
        case 'started': st.status = 'running'; break;
        case 'progress':
          st.status = 'running';
          if (typeof p.stdoutTail === 'string' && p.stdoutTail) st.output = p.stdoutTail;
          break;
        case 'error': {
          st.status = 'error';
          const err = p.error as Record<string, unknown> | undefined;
          st.error = String(err?.message ?? err ?? 'tool error');
          break;
        }
        default: break;
      }
      host.dirty.add(mid);
      host.scheduleFlush();
      break;
    }
    case 'session.titleUpdated': {
      const title = p.title;
      if (host.session && typeof title === 'string') {
        host.session.info.title = title;
        host.titleEl.textContent = title || host.t('appTitle');
      }
      break;
    }
    case 'session.updated': {
      // 宽松投影事件：字段可能在根级或嵌套在 projection 里，双读
      const proj2 = host.session?.projection as unknown as Record<string, unknown> | undefined;
      if (!proj2) break;
      const nested = (p.projection ?? null) as Record<string, unknown> | null;
      let touched2 = false;
      // 探针实证（probe-ctx）：payload 带 usage{totalTokens,...}、contextWindow（权威 1M）、
      // contextUsageBreakdown[{source,chars}]——回合中段即到达，是 contextUsed 最早正源
      const usage2 = p.usage as { totalTokens?: number; inputTokens?: number; outputTokens?: number } | undefined;
      const total2 = typeof usage2?.totalTokens === 'number' && usage2.totalTokens > 0
        ? usage2.totalTokens
        : undefined;
      if (total2 !== undefined && proj2.contextUsed !== total2) {
        proj2.contextUsed = total2;
        proj2.totalTokenCount = total2;
        touched2 = true;
      }
      if (typeof p.contextWindow === 'number' && p.contextWindow > 0 && proj2.contextWindow !== p.contextWindow) {
        proj2.contextWindow = p.contextWindow;
        touched2 = true;
      }
      if (Array.isArray(p.contextUsageBreakdown)) {
        host.setCtxBreakdown((p.contextUsageBreakdown as { source?: string; chars?: number }[])
          .filter((e) => typeof e.source === 'string' && typeof e.chars === 'number')
          .map((e) => ({ source: e.source!, chars: e.chars! })));
        touched2 = true;
      }
      for (const key of ['contextUsed', 'contextWindow', 'totalTokenCount', 'status', 'turnCount', 'backgroundJobs']) {
        const v = p[key] ?? (nested ? nested[key] : undefined);
        if (v !== undefined && v !== null && proj2[key] !== v) {
          proj2[key] = v;
          touched2 = true;
        }
      }
      if (touched2) {
        host.saveCtxSnapshot();
        host.renderContextRing();
        if (host.isOpenFor(host.ctxRingBtn)) host.toggleContextMenu(true);
      }
      break;
    }
    case 'turn.completed': {
      // 回合已结束：状态强制归位（state.updated 偶发缺 status 补丁时的兜底）
      if (host.session) (host.session.projection as unknown as { status: string }).status = 'idle';
      // 协议原生校准：turn.completed payload.usage 即本回合请求的 token 账目
      // contextUsed = input(含 cache 回放) + output —— 与 CLI reducer mfe 同构
      const usage = p.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined;
      const proj3 = host.session?.projection as unknown as Record<string, unknown> | undefined;
      if (usage && proj3) {
        const num = (v: unknown) => (typeof v === 'number' && v >= 0 ? v : undefined);
        const input = num(usage.inputTokens)
          ?? (num(usage.totalTokens) !== undefined && num(usage.outputTokens) !== undefined
            ? Math.max(0, (usage.totalTokens as number) - (usage.outputTokens as number))
            : ((num(usage.cacheReadTokens) ?? 0) + (num(usage.cacheWriteTokens) ?? 0) || undefined));
        const output = num(usage.outputTokens) ?? 0;
        const used = input !== undefined ? input + output : num(usage.totalTokens);
        if (used !== undefined) {
          proj3.contextUsed = used;
          if (typeof usage.totalTokens === 'number') proj3.totalTokenCount = usage.totalTokens;
          host.renderContextRing();
          if (host.isOpenFor(host.ctxRingBtn)) host.toggleContextMenu(true);
        }
      }
      // 回合结束：拉取权威消息列表，校准流式渲染与圆环
      host.post({ kind: 'refresh-messages' });
      host.renderStatus();
      break;
    }
    case 'turn.failed': {
      if (host.session) (host.session.projection as unknown as { status: string }).status = 'idle';
      const errMsg = (p.errorMessage ?? p.error) as string | undefined;
      host.showError(`${host.t('turnFailed')}${errMsg ? `: ${errMsg}` : ''}`);
      // 回合结束：拉取权威消息列表，校准流式渲染与圆环
      host.post({ kind: 'refresh-messages' });
      host.renderStatus();
      break;
    }
    case 'message.upserted': {
      const m = extractMessage(ev, p);
      if (!m) break;
      // 乐观回显合并：optimistic-user 先行入场（local- id），权威回显若另立新 key 会把
      // 用户消息追加到 Map 尾部——用户气泡被排到助手工具卡之后（时序错乱）。
      // 同文本配对命中时原位吸收权威内容（key 不变保住 DOM 位置与节点），并防双份气泡
      if (m.msg.info.role === 'user') {
        const local = [...host.messages.entries()].find(([id, mm]) =>
          id.startsWith('local-') && mm.info.role === 'user' && firstVisibleText(mm) === firstVisibleText(m.msg));
        if (local) {
          const [localId, entry] = local;
          entry.info = { ...m.msg.info, messageId: localId };
          entry.parts = m.msg.parts;
          host.dirty.add(localId);
          host.scheduleFlush();
          break;
        }
      }
      host.messages.set(m.id, m.msg);
      host.dirty.add(m.id);
      host.scheduleFlush();
      break;
    }
    case 'message.removed': {
      const id = String(p.messageId ?? ev.messageId ?? '');
      if (id && host.messages.delete(id)) {
        host.messagesEl.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.remove();
      }
      break;
    }
    case 'part.upserted': {
      const part = (p.part ?? ev.part) as MessagePart | undefined;
      if (part?.partId && part.messageId) {
        upsertPart(host, String(part.messageId), part);
      }
      break;
    }
    case 'part.delta': {
      const messageId = String(p.messageId ?? ev.messageId ?? '');
      const partId = String(p.partId ?? ev.partId ?? '');
      const delta = String(p.delta ?? '');
      if (!messageId || !partId || !delta) break;
      const field = String(p.field ?? 'text');
      const m = ensureMessage(host, messageId, 'assistant');
      let part = m.parts.find((x) => x.partId === partId);
      if (!part) {
        part = {
          type: field === 'reasoning' ? 'reasoning' : 'text',
          partId,
          messageId,
          sessionId: '',
          text: ''
        } as unknown as MessagePart;
        m.parts.push(part);
      }
      if (field === 'reasoning' || field === 'text') {
        (part as { text?: string }).text = ((part as { text?: string }).text ?? '') + delta;
      } else if (field === 'output') {
        const st = (part as { state?: { output?: string } }).state;
        if (st) st.output = (st.output ?? '') + delta;
      }
      host.dirty.add(messageId);
      host.scheduleFlush();
      break;
    }
    case 'permission.requested': {
      // 权限卡片由 interaction/requestPermission 反向请求驱动；事件重复到达时忽略
      const rid = String(p.requestId ?? ev.requestId ?? '');
      if (rid && !host.pendingPermissions.has(rid)) {
        const req = { ...p, requestId: rid } as unknown as PermissionRequestParams;
        if (req.options && req.toolName) host.pendingPermissions.set(rid, req);
        host.markDirtyPermissions();
      }
      break;
    }
    case 'permission.resolved': {
      const rid = String(p.requestId ?? ev.requestId ?? '');
      if (rid) {
        host.pendingPermissions.delete(rid);
        host.ixDrafts.delete(rid);
        host.markDirtyPermissions();
        host.renderStatus();
      }
      break;
    }
    case 'userInput.resolved': {
      const rid = String(p.requestId ?? ev.requestId ?? '');
      if (rid) {
        host.pendingUserInputs.delete(rid);
        host.ixDrafts.delete(rid);
        host.markDirtyPermissions();
      }
      break;
    }
    default:
      break; // 其余事件（checkpoint/rewind/streamRecovery 等）暂不渲染
  }
}

/** 当前流式回合对应的助手消息 id（无则造一个稳定 id） */
function streamMessageId(host: EventHost): string {
  if (!host.currentAssistantId) host.currentAssistantId = `stream-${host.session?.info.sessionId ?? 'local'}-${Date.now()}`;
  return host.currentAssistantId;
}

/** 流式增量追加：text 进正文部件，reasoning 进思考部件 */
function appendToStreamPart(host: EventHost, messageId: string, partId: string, kind: 'text' | 'reasoning', delta: string): void {
  host.currentAssistantId = messageId;
  const m = ensureMessage(host, messageId, 'assistant');
  let part = m.parts.find((x) => x.partId === partId) as { text?: string; type?: string } | undefined;
  if (!part) {
    const np: Record<string, unknown> = {
      type: kind === 'reasoning' ? 'reasoning' : 'text',
      partId,
      messageId,
      sessionId: '',
      text: ''
    };
    m.parts.push(np as unknown as MessagePart);
    part = np as unknown as { text?: string };
  }
  part.text = (part.text ?? '') + delta;
  host.dirty.add(messageId);
  host.scheduleFlush();
}

function ensureMessage(host: EventHost, id: string, role: string): MutableSessionMessage {
  let m = host.messages.get(id);
  if (!m) {
    m = { info: { role, messageId: id }, parts: [] };
    host.messages.set(id, m);
  }
  return m;
}

function upsertPart(host: EventHost, messageId: string, part: MessagePart): void {
  const m = ensureMessage(host, messageId, 'assistant');
  const i = m.parts.findIndex((p) => p.partId === part.partId);
  if (i >= 0) m.parts[i] = part;
  else m.parts.push(part);
  host.dirty.add(messageId);
  host.scheduleFlush();
}

function findToolPart(host: EventHost, callId: string): MessagePart | null {
  for (const m of host.messages.values()) {
    for (const p of m.parts) {
      if (p.type === 'tool' && (p as { callId?: string }).callId === callId) return p;
    }
  }
  return null;
}

/** 消息首个可见文本部件的内容（乐观消息与权威回显的同源配对依据） */
function firstVisibleText(m: MutableSessionMessage): string {
  for (const p of m.parts) {
    if (p.type === 'text') {
      const tp = p as unknown as { text?: string; ignored?: boolean };
      if (!tp.ignored) return tp.text ?? '';
    }
  }
  return '';
}

/** 消息事件 → 可变消息（messageId 兜底 + parts 归一化） */
function extractMessage(ev: SessionEvent, payload?: Record<string, unknown>): { id: string; msg: MutableSessionMessage } | null {
  const anyEv = ev as unknown as Record<string, unknown>;
  const source = (payload ?? {}) as Record<string, unknown>;
  const hasParts = source.parts != null || anyEv.parts != null;
  // ?? 优先级高于 ?:——先取嵌套 message，再按有无 parts 兜底到信封根级（缺括号会把嵌套形状整条解析成 null）
  const raw = ((source.message ?? anyEv.message) ?? (hasParts ? { ...source } : anyEv)) as Record<string, unknown>;
  const info = (raw.info ?? (raw.role ? { role: raw.role } : null)) as { role?: string; messageId?: string; [k: string]: unknown } | null;
  const content = raw.content;
  const parts = (raw.parts ?? (typeof content === 'string' ? [{ type: 'text', text: content }] : null)) as MessagePart[] | null;
  if (!info && !parts) return null;
  const id = String(info?.messageId ?? anyEv.messageId ?? source.messageId ?? `ev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const normalizedParts = (parts ?? []).map((pp, i) => ({
    ...pp,
    partId: (pp as { partId?: string }).partId ?? `${id}-p${i}`,
    messageId: (pp as { messageId?: string }).messageId ?? id,
    sessionId: (pp as { sessionId?: string }).sessionId ?? ''
  }));
  const role = info?.role ?? 'assistant';
  return {
    id,
    msg: { info: { ...(info ?? {}), role, messageId: id }, parts: normalizedParts }
  };
}

/**
 * 服务端消息 id 方言归一：resume 载荷用 info.messageId，session/messages 载荷用 info.id
 * （同一会话两种形状，探针实证逐条同值）。原地回填 messageId 后返回；
 * 缺失时返回空串，由调用方退化索引 id。
 */
export function normalizeMessageId(m: MutableSessionMessage): string {
  const info = m.info ?? { role: '' };
  m.info = info;
  const legacy = (info as { id?: unknown }).id;
  if (!info.messageId && typeof legacy === 'string' && legacy) info.messageId = legacy;
  return info.messageId ?? '';
}

/** 工具结果对象 → 展示文本（宽容尝试多种字段；内容块数组还原多行文本，兜底 pretty JSON 保结构） */
function extractToolResultText(result: Record<string, unknown> | undefined): string | null {
  if (!result || typeof result !== 'object') return null;
  for (const k of ['output', 'content', 'summary', 'text', 'display', 'stdout']) {
    const v = result[k];
    if (typeof v === 'string' && v) return v;
  }
  // MCP 内容块（标准 content 键或 zai 式单键块数组）：提取真实换行的文本，勿整体 stringify 拍扁
  const texts = extractContentTexts(result);
  if (texts) return texts.join('\n\n');
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return null;
  }
}
