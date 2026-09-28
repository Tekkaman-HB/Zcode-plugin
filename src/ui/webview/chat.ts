/**
 * [INPUT]: 消费 ../../protocol/types、./render、./interaction、./i18n、../../ui/bridge 的契约类型
 * [OUTPUT]: 对外提供 ChatApp（webview 聊天应用：状态机 + 事件适配 + 交互）
 * [POS]: webview 的中枢——接收扩展侧桥接消息，驱动渲染层；交互焦点队列在此排队并驱动 ./interaction 的卡片
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type {
  SessionMessage,
  MessagePart,
  SessionSettings,
  SessionProjection,
  SlashCommand,
  SessionEvent,
  PermissionRequestParams,
  PermissionResponse,
  UserInputRequestParams,
  UserInputResponse,
  AvailableModel,
  ToolPart
} from '../../protocol/types';
import type { ToWebviewMessage, FromWebviewMessage, BootstrapPayload, DirEntry, AttachmentRef } from '../bridge';
import { h, renderMessage, esc, relTime, resetToolCollapseState } from './render';
import { renderPermissionCard, renderUserInputCard, createInteractionDraft, type InteractionDraft } from './interaction';
import { makeT, type Locale, type Translate } from './i18n';

interface MutableSessionMessage {
  info: { role: string; messageId?: string; [k: string]: unknown };
  parts: MessagePart[];
}

/** 模式 chip 短名（中文对齐桌面端语义） */
const MODE_CHIP_LABEL: Record<string, string> = {
  plan: '计划模式',
  build: '变更前确认',
  edit: '自动编辑',
  yolo: '完全访问'
};

const SUGGESTIONS: { zh: string; en: string }[] = [
  { zh: '帮我分析这个项目的结构', en: 'Analyze this project structure' },
  { zh: '修复当前的 TypeScript 编译错误', en: 'Fix the TypeScript errors' },
  { zh: '为这个函数写单元测试', en: 'Write unit tests for this function' }
];

/** 模式图标（chip 与菜单共用，随 currentColor 着色） */
const MODE_ICONS: Record<string, string> = {
  plan: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="3" y="2.5" width="10" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  build: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M5.5 9.5 3 12l-1 2 2-1 2.5-2.5M9 3.5a2.5 2.5 0 0 1 3.5 3.5L8 11.5 5.5 9 11 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  edit: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M9.5 3.5l3 3L6 13H3v-3l6.5-6.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  yolo: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8.5 2 4 9h3.5L7 14l4.5-7H8l.5-5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
};

export class ChatApp {
  private t: Translate;
  private locale: Locale = 'en-US';
  private environmentOk = true;
  private environmentDetail: string | undefined;
  private account: BootstrapPayload['account'] = null;
  private serverState = 'stopped';
  private defaultMode = 'build';
  private serverDetail: string | undefined;
  private session: { info: { title?: string; sessionId: string }; settings: SessionSettings; projection: SessionProjection; slashCommands: SlashCommand[] } | null = null;
  private messages = new Map<string, MutableSessionMessage>();
  private dirty = new Set<string>();
  private pendingPermissions = new Map<string, PermissionRequestParams>();
  private pendingUserInputs = new Map<string, UserInputRequestParams>();
  /** 交互卡草稿（键 = requestId，两通道共用——CLI 会在两通道复用同一 requestId）：重渲染不丢已答内容与向导进度 */
  private ixDrafts = new Map<string, InteractionDraft>();
  /** 当前拥有焦点的交互卡（type:id）——只在队首切换时抢焦点，重渲染不偷 */
  private ixHeadId: string | null = null;
  private flushScheduled = false;
  private vscodeApi: { postMessage(msg: FromWebviewMessage): void } | undefined;

  // DOM 引用
  private root!: HTMLElement;
  private banner!: HTMLElement;
  private messagesEl!: HTMLElement;
  private composerInput!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private modelBtn!: HTMLButtonElement;
  private modeBtn!: HTMLButtonElement;
  private titleEl!: HTMLElement;
  private overlayEl!: HTMLElement;
  private popupEl!: HTMLElement;
  private attachRow!: HTMLElement;
  private queuedEl!: HTMLElement;
  private queuedCount = 0;
  private queuedItems: { id: string; content: string }[] = [];
  /** 交互焦点队列：权限卡与用户输入卡统一排队，tab 可点切换，一次亮一张 */
  private interactionOrder: { type: 'permission' | 'input'; id: string }[] = [];
  /** 当前展示的队列位次（tab 点击切换；提交后原地指向下一条） */
  private ixSelected = 0;
  private thinkTimer: ReturnType<typeof setInterval> | undefined;
  private thinkStart = 0;
  private pasteSeq = 0;
  private previewRegistry = new Map<string, string>();
  private pastePending = new Map<string, string>();
  private previewEl: HTMLElement | null = null;
  private ctxBreakdown: { source: string; chars: number }[] | null = null;
  private popupAnchor: HTMLElement | null = null;
  private historyBtn!: HTMLButtonElement;
  private gearBtn!: HTMLButtonElement;
  private ctxRingBtn!: HTMLButtonElement;
  private slashIndex = -1;
  private attachments: AttachmentRef[] = [];
  private atDir = '';
  private dirEntries: { dir: string; entries: DirEntry[] } | null = null;
  private sessionsMenuOpen = false;
  private currentAssistantId: string | null = null;
  private mcp: { started: number; done: boolean; configuredCount?: number; connectedCount?: number; failedCount?: number; servers?: string[]; crashed?: string[] } | null = null;
  private usage: { range: string; totalTokens: number } | null = null;
  private mcpServers: { name: string; pid: number; source: string }[] | null = null;

  constructor() {
    this.t = makeT('en-US');
  }

  mount(root: HTMLElement): void {
    this.root = root;
    root.innerHTML = '';
    this.buildShell();
  }

  setApi(api: { postMessage(msg: FromWebviewMessage): void }): void {
    this.vscodeApi = api;
  }

  private post(msg: FromWebviewMessage): void {
    this.vscodeApi?.postMessage(msg);
  }

  // ═══════════════ 骨架 ═══════════════

  private buildShell(): void {
    // 顶部标题行（对标 Claude Code）：左侧会话标题，右侧时钟/新建两个幽灵图标
    const titlebar = h('div', { class: 'chat-titlebar' },
      this.titleEl = h('div', { class: 'chat-title' }, this.t('appTitle')),
      h('div', { class: 'titlebar-actions' },
        this.historyBtn = h('button', { class: 'titlebar-btn', title: this.t('sessions'), onclick: () => this.toggleSessionsMenu() }, clockIconEl()),
        h('button', { class: 'titlebar-btn', title: this.t('newSession'), onclick: () => this.post({ kind: 'new-session' }) }, plusIconEl())
      )
    );
    this.banner = h('div', { class: 'banner hidden' });
    this.messagesEl = h('div', { class: 'messages', id: 'messages' });
    this.overlayEl = h('div', { class: 'overlay' });
    this.popupEl = h('div', { class: 'popup hidden' });

    // 输入区（对标 Claude Code）：附件 chips 行 → 文本框 → 控制栏
    // 左：+ 附件 / @ 引用 / 模型 / 齿轮(配置收纳)  右：模式 / 发送
    this.attachRow = h('div', { class: 'attach-row hidden' });
    this.queuedEl = h('div', { class: 'queued-row hidden' });
    const composer = h('div', { class: 'composer' },
      this.queuedEl,
      h('div', { class: 'composer-inner' },
        this.attachRow,
        this.composerInput = h('textarea', { class: 'composer-input', placeholder: this.t('inputPlaceholder'), rows: '1' }) as HTMLTextAreaElement
      ),
      h('div', { class: 'composer-bar' },
        h('div', { class: 'composer-bar-left' },
          h('button', { class: 'bar-icon-btn', title: this.t('attach'), onclick: () => this.post({ kind: 'attach-pick' }) }, plusIconEl()),
          h('button', { class: 'bar-icon-btn', title: this.t('reference'), onclick: () => this.onAtReference() }, atIconEl()),
          this.modelBtn = h('button', { class: 'composer-chip', onclick: () => this.toggleModelMenu() }, '…'),
          this.gearBtn = h('button', { class: 'bar-icon-btn', title: this.t('settings'), onclick: () => this.toggleSettingsMenu() }, gearIconEl())
        ),
        h('div', { class: 'composer-bar-right' },
          this.ctxRingBtn = h('button', { class: 'ctx-ring-btn hidden', onclick: () => this.toggleContextMenu() }),
          this.modeBtn = h('button', { class: 'composer-chip', onclick: () => this.toggleModeMenu() }, '…'),
          this.sendBtn = h('button', { class: 'send-btn', title: this.t('send'), onclick: () => this.onSend() }, '↑') as HTMLButtonElement
        )
      )
    );

    this.root.append(
      titlebar,
      this.banner,
      this.messagesEl,
      this.overlayEl,
      this.popupEl,
      composer
    );

    this.composerInput.addEventListener('keydown', (e) => this.onKeydown(e));
    this.composerInput.addEventListener('input', () => this.onInput());
    // Cmd/Ctrl+V 粘贴图片：取剪贴板 image 项 → dataUrl → 宿主落地临时文件
    this.composerInput.addEventListener('paste', (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        this.pasteSeq++;
        const label = this.locale === 'zh-CN' ? `图片${this.pasteSeq}.png` : `Image${this.pasteSeq}.png`;
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            // 协议图片必须走 localPath（probe 实证 dataBase64 不送达）：宿主落盘后回填 path
            this.pastePending.set(label, reader.result);
            this.previewRegistry.set(label, reader.result);
            this.post({ kind: 'save-image', dataUrl: reader.result, name: label });
          }
        };
        reader.readAsDataURL(file);
        return;
      }
    });
    // 用 mousedown 判定"点外部关闭"：click 时菜单 DOM 可能已被 onclick 重建，旧 target 脱离导致误判闪关
    document.addEventListener('mousedown', (e) => {
      const target = e.target as HTMLElement;
      if (this.popupEl.contains(target)) return;
      // 触发按钮自身的点击由各自 toggle 处理（同按钮=关闭，异按钮=换菜单）
      if (target.closest?.('.bar-icon-btn, .composer-chip, .titlebar-btn, .ctx-ring-btn')) return;
      this.hidePopup();
    });
    this.renderOverlay();
  }

  // ═══════════════ 桥接消息入口 ═══════════════

  onMessage(msg: ToWebviewMessage): void {
    switch (msg.kind) {
      case 'bootstrap':
        this.locale = msg.data.locale;
        this.t = makeT(this.locale);
        this.environmentOk = msg.data.environmentOk;
        this.environmentDetail = msg.data.environmentDetail;
        this.account = msg.data.account;
        this.serverState = msg.data.serverState;
        this.renderOverlay();
        this.renderBanner();
        this.renderStatus();
        this.renderHeaderControls();
        break;
      case 'server-state':
        this.serverState = msg.state;
        this.serverDetail = msg.detail;
        this.renderBanner();
        this.renderStatus();
        break;
      case 'account':
        this.account = msg.data;
        this.renderOverlay();
        this.renderStatus();
        break;
      case 'session-snapshot': {
        resetToolCollapseState();
        this.previewRegistry.clear();
        const d = msg.data;
        this.session = {
          info: { title: d.session.title, sessionId: d.session.sessionId },
          settings: d.settings,
          projection: d.projection,
          slashCommands: d.slashCommands ?? []
        };
        this.messages.clear();
        for (const m of d.messages ?? []) {
          const id = String(m.info?.messageId ?? `m-${this.messages.size}`);
          this.messages.set(id, m as MutableSessionMessage);
        }
        this.pendingPermissions.clear();
        this.pendingUserInputs.clear();
        this.ixDrafts.clear();
        this.ixHeadId = null;
        this.mcp = null;
        this.rebuildMessages();
        this.hydrateAttachmentThumbs();
        this.renderHeaderControls();
        this.renderOverlay();
        this.renderStatus();
        break;
      }
      case 'session-closed':
        resetToolCollapseState();
        this.session = null;
        this.messages.clear();
        this.pendingPermissions.clear();
        this.pendingUserInputs.clear();
        this.ixDrafts.clear();
        this.ixHeadId = null;
        this.mcp = null;
        this.usage = null;
        this.ctxBreakdown = null;
        this.queuedCount = 0;
        this.queuedItems = [];
        this.renderQueued();
        this.rebuildMessages();
        this.renderHeaderControls();
        this.renderOverlay();
        break;
      case 'session-event':
        this.onSessionEvent(msg.data);
        break;
      case 'state-updated':
        this.applyProjectionPatch(msg.data.patch);
        break;
      case 'permission-request': {
        // 同一 requestId 重试（CLI 每 1s reannounce 未答请求）不重复入队；
        // 载荷未变时跳过重渲染——保住表单草稿/键盘选中态/DOM 焦点（每秒重建会清掉用户正在输入的反馈）
        const rid = msg.data.requestId;
        const prev = this.pendingPermissions.get(rid);
        const changed = !prev || JSON.stringify(prev) !== JSON.stringify(msg.data);
        this.pendingPermissions.set(rid, msg.data);
        if (!this.interactionOrder.some((e) => e.type === 'permission' && e.id === rid)) {
          this.interactionOrder.push({ type: 'permission', id: rid });
        }
        if (changed) this.markDirtyPermissions();
        this.renderStatus();
        break;
      }
      case 'user-input-request': {
        const rid = msg.data.requestId;
        const prev = this.pendingUserInputs.get(rid);
        const changed = !prev || JSON.stringify(prev) !== JSON.stringify(msg.data);
        this.pendingUserInputs.set(rid, msg.data);
        if (!this.interactionOrder.some((e) => e.type === 'input' && e.id === rid)) {
          this.interactionOrder.push({ type: 'input', id: rid });
        }
        if (changed) this.markDirtyPermissions();
        break;
      }
      case 'sessions-list':
        this.renderSessionsMenu(msg.data.sessions);
        break;
      case 'attachments-picked': {
        for (const a of msg.data.attachments) {
          if (!this.attachments.some((x) => x !== a && x.name === a.name)) this.attachments.push(a);
          if (a.dataUrl) this.previewRegistry.set(a.name, a.dataUrl);
        }
        this.renderAttachRow();
        this.updateSendAffordance();
        break;
      }
      case 'files-list':
        this.dirEntries = msg.data;
        this.renderAtPopup();
        break;
      case 'mcp-progress': {
        this.mcp = msg.data;
        this.renderStatus();
        break;
      }
      case 'usage': {
        this.usage = msg.data;
        this.renderStatus();
        break;
      }
      case 'image-saved': {
        // 宿主落盘完成：以 localPath 入列（dataUrl 仅留在 webview 供缩略/预览）
        const d = msg.data;
        if (!this.attachments.some((x) => x.path === d.path)) {
          this.attachments.push({ name: d.name, path: d.path, mime: d.mime, dataUrl: this.pastePending.get(d.name) });
        }
        this.pastePending.delete(d.name);
        this.renderAttachRow();
        this.updateSendAffordance();
        break;
      }
      case 'queued-update': {
        this.queuedCount = msg.data.queued;
        this.queuedItems = msg.data.items ?? [];
        this.renderQueued();
        break;
      }
      case 'optimistic-user': {
        // 受理即显示用户消息（排队/插队场景服务端回显延迟数秒）；等长文本去重防双份
        const d = msg.data;
        const dup = [...this.messages.values()].some(
          (m) => m.info.role === 'user' && m.parts.some((pp) => pp.type === 'text' && (pp as { text?: string }).text === d.text)
        );
        if (dup) break;
        this.messages.set(d.id, {
          info: { role: 'user', messageId: d.id },
          parts: [
            { type: 'text', partId: `${d.id}-p`, messageId: d.id, sessionId: '', text: d.text } as MessagePart,
            ...(d.attachments ?? []).map((a, i) => ({ type: 'file', partId: `${d.id}-f${i}`, messageId: d.id, sessionId: '', mime: 'application/octet-stream', filename: a.name, url: '' }) as unknown as MessagePart)
          ]
        });
        this.dirty.add(d.id);
        this.scheduleFlush();
        this.renderOverlay();
        break;
      }
      case 'mcp-servers': {
        this.mcpServers = msg.data.servers;
        if (this.isOpenFor(this.gearBtn) && !this.mcpServers.length) {
          this.hidePopup();
          break;
        }
        if (this.isOpenFor(this.gearBtn)) this.renderMcpMenu();
        break;
      }
      case 'messages': {
        // 权威消息列表校准（回合结束后/工具完成时拉取）
        this.messages.clear();
        for (const m of msg.data.messages ?? []) {
          const id = String(m.info?.messageId ?? `m-${this.messages.size}`);
          // 服务端部件无 partId、callId 写作 callID——归一化（折叠记忆/增量更新依赖 partId）
          (m as MutableSessionMessage).parts = (m.parts ?? []).map((pp, i) => ({
            ...pp,
            partId: (pp as { partId?: string }).partId ?? `${id}-p${i}`,
            callId: (pp as { callId?: string }).callId ?? (pp as { callID?: string }).callID
          } as MessagePart));
          this.messages.set(id, m as MutableSessionMessage);
        }
        this.currentAssistantId = null;
        // contextUsed 权威校准：assistant 消息最后一个 step-finish part 的 tokens 账目
        const lastFinish = (() => {
          for (const m of [...this.messages.values()].reverse()) {
            for (const part of [...m.parts].reverse()) {
              if (part.type === 'step-finish') {
                const t = (part as unknown as { tokens?: { total?: number; input?: number; output?: number; cache?: { read?: number; write?: number } } }).tokens;
                if (t && (t.total !== undefined || t.input !== undefined)) return t;
              }
            }
          }
          return null;
        })();
        if (lastFinish && this.session) {
          const proj = this.session.projection as unknown as { contextUsed: number };
          const used = lastFinish.total
            ?? ((lastFinish.input ?? 0) + (lastFinish.cache?.read ?? 0) + (lastFinish.cache?.write ?? 0) + (lastFinish.output ?? 0));
          if (used > 0) proj.contextUsed = used;
        }
        this.rebuildMessages();
        this.renderContextRing();
        if (this.isOpenFor(this.ctxRingBtn)) this.toggleContextMenu(true);
        break;
      }
      case 'error':
        this.showError(msg.message);
        break;
    }
  }

  // ═══════════════ 事件适配（宽容解析） ═══════════════
  // 信封结构：{type, payload:{...}}；旧路径（无 payload）按根级字段兜底

  private onSessionEvent(ev: SessionEvent): void {
    const p = ((ev as unknown as { payload?: Record<string, unknown> }).payload ?? ev) as Record<string, unknown>;
    switch (ev.type) {
      case 'model.streaming': {
        const kind = String(p.kind ?? '');
        const mid = String(p.assistantMessageId ?? ev.messageId ?? this.streamMessageId());
        const delta = typeof p.delta === 'string' ? p.delta : '';
        const partId = String(p.partId ?? '');
        if (kind === 'text_delta' && delta) {
          this.appendToStreamPart(mid, partId || `text-${mid}`, 'text', delta);
        } else if (kind === 'reasoning_delta' && delta) {
          this.appendToStreamPart(mid, partId || `reasoning-${mid}`, 'reasoning', delta);
        } else if (kind === 'text_start' || kind === 'reasoning_start' || kind === 'start') {
          this.ensureMessage(mid, 'assistant');
        }
        break;
      }
      case 'tool.updated': {
        const kind = String(p.kind ?? '');
        const toolCallId = String(p.toolCallId ?? '');
        if (!toolCallId) break;
        const existing = this.findToolPart(toolCallId);
        const toolName = String(p.toolName ?? (existing && (existing as unknown as { toolName?: string }).toolName) ?? 'tool');
        const mid = this.currentAssistantId ?? `tools-${ev.turnId ?? 'current'}`;
        const msg = this.ensureMessage(mid, 'assistant');
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
            this.post({ kind: 'refresh-messages' });
            break;
          case 'result': {
            st.status = 'completed';
            this.post({ kind: 'refresh-messages' });
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
        this.dirty.add(mid);
        this.scheduleFlush();
        break;
      }
      case 'session.titleUpdated': {
        const title = p.title;
        if (this.session && typeof title === 'string') {
          this.session.info.title = title;
          this.titleEl.textContent = title || this.t('appTitle');
        }
        break;
      }
      case 'session.updated': {
        // 宽松投影事件：字段可能在根级或嵌套在 projection 里，双读
        const proj2 = this.session?.projection as unknown as Record<string, unknown> | undefined;
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
          this.ctxBreakdown = (p.contextUsageBreakdown as { source?: string; chars?: number }[])
            .filter((e) => typeof e.source === 'string' && typeof e.chars === 'number')
            .map((e) => ({ source: e.source!, chars: e.chars! }));
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
          this.renderContextRing();
          if (this.isOpenFor(this.ctxRingBtn)) this.toggleContextMenu(true);
        }
        break;
      }
      case 'turn.completed': {
        // 回合已结束：状态强制归位（state.updated 偶发缺 status 补丁时的兜底）
        if (this.session) (this.session.projection as unknown as { status: string }).status = 'idle';
        // 协议原生校准：turn.completed payload.usage 即本回合请求的 token 账目
        // contextUsed = input(含 cache 回放) + output —— 与 CLI reducer mfe 同构
        const usage = p.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined;
        const proj3 = this.session?.projection as unknown as Record<string, unknown> | undefined;
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
            this.renderContextRing();
            if (this.isOpenFor(this.ctxRingBtn)) this.toggleContextMenu(true);
          }
        }
        // 回合结束：拉取权威消息列表，校准流式渲染与圆环
        this.post({ kind: 'refresh-messages' });
        this.renderStatus();
        break;
      }
      case 'turn.failed': {
        if (this.session) (this.session.projection as unknown as { status: string }).status = 'idle';
        const errMsg = (p.errorMessage ?? p.error) as string | undefined;
        this.showError(`${this.t('turnFailed')}${errMsg ? `: ${errMsg}` : ''}`);
        // 回合结束：拉取权威消息列表，校准流式渲染与圆环
        this.post({ kind: 'refresh-messages' });
        this.renderStatus();
        break;
      }
      case 'message.upserted': {
        const m = extractMessage(ev, p);
        if (m) {
          this.messages.set(m.id, m.msg);
          this.dirty.add(m.id);
          this.scheduleFlush();
        }
        break;
      }
      case 'message.removed': {
        const id = String(p.messageId ?? ev.messageId ?? '');
        if (id && this.messages.delete(id)) {
          this.messagesEl.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.remove();
        }
        break;
      }
      case 'part.upserted': {
        const part = (p.part ?? ev.part) as MessagePart | undefined;
        if (part?.partId && part.messageId) {
          this.upsertPart(String(part.messageId), part);
        }
        break;
      }
      case 'part.delta': {
        const messageId = String(p.messageId ?? ev.messageId ?? '');
        const partId = String(p.partId ?? ev.partId ?? '');
        const delta = String(p.delta ?? '');
        if (!messageId || !partId || !delta) break;
        const field = String(p.field ?? 'text');
        const m = this.ensureMessage(messageId, 'assistant');
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
        this.dirty.add(messageId);
        this.scheduleFlush();
        break;
      }
      case 'permission.requested': {
        // 权限卡片由 interaction/requestPermission 反向请求驱动；事件重复到达时忽略
        const rid = String(p.requestId ?? ev.requestId ?? '');
        if (rid && !this.pendingPermissions.has(rid)) {
          const req = { ...p, requestId: rid } as unknown as PermissionRequestParams;
          if (req.options && req.toolName) this.pendingPermissions.set(rid, req);
          this.markDirtyPermissions();
        }
        break;
      }
      case 'permission.resolved': {
        const rid = String(p.requestId ?? ev.requestId ?? '');
        if (rid) {
          this.pendingPermissions.delete(rid);
          this.ixDrafts.delete(rid);
          this.markDirtyPermissions();
          this.renderStatus();
        }
        break;
      }
      case 'userInput.resolved': {
        const rid = String(p.requestId ?? ev.requestId ?? '');
        if (rid) {
          this.pendingUserInputs.delete(rid);
          this.ixDrafts.delete(rid);
          this.markDirtyPermissions();
        }
        break;
      }
      default:
        break; // 其余事件（checkpoint/rewind/streamRecovery 等）暂不渲染
    }
  }

  /** 当前流式回合对应的助手消息 id（无则造一个稳定 id） */
  private streamMessageId(): string {
    if (!this.currentAssistantId) this.currentAssistantId = `stream-${this.session?.info.sessionId ?? 'local'}-${Date.now()}`;
    return this.currentAssistantId;
  }

  /** 流式增量追加：text 进正文部件，reasoning 进思考部件 */
  private appendToStreamPart(messageId: string, partId: string, kind: 'text' | 'reasoning', delta: string): void {
    this.currentAssistantId = messageId;
    const m = this.ensureMessage(messageId, 'assistant');
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
    this.dirty.add(messageId);
    this.scheduleFlush();
  }

  /** 乐观更新当前模型/档位（patch 回流前 chip 即时反馈） */
  private optimisticSetModel(providerId: string, modelId: string, reasoningLevel?: string): void {
    if (!this.session) return;
    const sel = { providerId, modelId, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) };
    this.session.settings.model.current = sel;
    this.session.settings.model.lastUsed = sel;
    this.renderHeaderControls();
  }

  private ensureMessage(id: string, role: string): MutableSessionMessage {
    let m = this.messages.get(id);
    if (!m) {
      m = { info: { role, messageId: id }, parts: [] };
      this.messages.set(id, m);
    }
    return m;
  }

  private upsertPart(messageId: string, part: MessagePart): void {
    const m = this.ensureMessage(messageId, 'assistant');
    const i = m.parts.findIndex((p) => p.partId === part.partId);
    if (i >= 0) m.parts[i] = part;
    else m.parts.push(part);
    this.dirty.add(messageId);
    this.scheduleFlush();
  }

  private findToolPart(callId: string): MessagePart | null {
    for (const m of this.messages.values()) {
      for (const p of m.parts) {
        if (p.type === 'tool' && (p as { callId?: string }).callId === callId) return p;
      }
    }
    return null;
  }

  private applyProjectionPatch(patch: Record<string, unknown>): void {
    if (!this.session) return;
    // state.updated 的 model/mode/permission/thoughtLevel 是 settings 形状（整体替换），其余归 projection
    const SETTINGS_KEYS = new Set(['model', 'mode', 'permission', 'thoughtLevel']);
    const settings = this.session.settings as unknown as Record<string, unknown>;
    const proj = this.session.projection as unknown as Record<string, unknown>;
    let settingsTouched = false;
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'model' && v && typeof v === 'object') {
        // 实测：patch.model.available 只含当前选中模型且 contextWindow 是降级值；
        // create 响应才是配置权威（完整列表+真实窗口）。只取 current/lastUsed，新增模型才追加。
        const pm = v as SessionSettings['model'];
        const sm = this.session.settings.model;
        const known = new Set(sm.available.map((m) => `${m.ref.providerId}/${m.ref.modelId}`));
        const additions = (pm.available ?? []).filter((m) => !known.has(`${m.ref.providerId}/${m.ref.modelId}`));
        this.session.settings.model = {
          ...sm,
          current: pm.current ?? sm.current,
          lastUsed: pm.lastUsed ?? sm.lastUsed,
          available: sm.available.length ? [...sm.available, ...additions] : (pm.available ?? sm.available)
        };
        settingsTouched = true;
      } else if (SETTINGS_KEYS.has(k)) {
        settings[k] = v;
        settingsTouched = true;
      } else {
        proj[k] = v;
      }
    }
    if (settingsTouched) this.renderHeaderControls();
    if (patch.status !== undefined) this.renderStatus();
    else this.renderContextRing();
    if (patch.status === 'running') this.scrollBottom();
  }

  // ═══════════════ 渲染刷新 ═══════════════

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      const nearBottom = this.isNearBottom();
      const streaming = this.session?.projection.status === 'running';
      for (const id of this.dirty) {
        const m = this.messages.get(id);
        if (!m) continue;
        const existing = this.messagesEl.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
        if (existing && streaming && this.updateMessageIncrementally(existing as HTMLElement, m)) {
          continue; // 增量路径：只改文本节点，零重建
        }
        const node = renderMessage(m as unknown as SessionMessage, this.t, (name, url, isImg) => this.onAttachmentClick(name, url, isImg));
        if (existing) existing.replaceWith(node);
        else this.insertMessageNode(node, id);
      }
      this.dirty.clear();
      if (nearBottom) this.scrollBottom();
      this.renderThinkingState();
      this.hydrateAttachmentThumbs();
    });
  }

  /**
   * 流式增量更新：只写已有 part 节点的文本内容（textContent——无 markdown 重解析、无 DOM 重建）。
   * 返回 false 表示结构已变（新部件/工具状态变化），需要整消息重建。
   * 回合结束后的 refresh-messages 全量重建会补上 markdown 渲染。
   */
  private updateMessageIncrementally(node: HTMLElement, m: MutableSessionMessage): boolean {
    for (const p of m.parts) {
      const pid = (p as { partId?: string }).partId;
      if (!pid) continue;
      const target = node.querySelector(`[data-part-id="${CSS.escape(pid)}"]`);
      if (!target) return false; // 新部件（tool/新文本块）→ 重建
      if (p.type === 'text') {
        const tp = p as unknown as { text?: string };
        target.textContent = tp.text ?? '';
        // pre-wrap 原文模式 + 流式块状光标（caret-blink）；全量重建时这两类随节点消失
        target.classList.add('raw', 'streaming');
      } else if (p.type === 'reasoning') {
        const body = target.querySelector('.reasoning-body') as HTMLElement | null;
        if (body) {
          body.textContent = (p as unknown as { text?: string }).text ?? '';
          body.classList.add('streaming');
        }
      } else if (p.type === 'tool') {
        return false; // 工具状态变化 → 重建（低频，可接受）
      }
    }
    return true;
  }

  /** 按插入序追加（事件到达顺序即会话顺序） */
  private insertMessageNode(node: HTMLElement, id: string): void {
    // 权限/输入卡片固定在流末尾之前
    const anchor = this.messagesEl.querySelector('.permission-card, .user-input-card');
    if (anchor) this.messagesEl.insertBefore(node, anchor);
    else this.messagesEl.append(node);
    void id;
  }

  private rebuildMessages(): void {
    this.messagesEl.innerHTML = '';
    for (const [id, m] of this.messages) {
      this.messagesEl.append(renderMessage(m as unknown as SessionMessage, this.t, (name, url, isImg) => this.onAttachmentClick(name, url, isImg)));
      void id;
    }
    this.renderPermissionCards();
    this.scrollBottom();
    this.renderThinkingState();
  }

  private markDirtyPermissions(): void {
    this.renderPermissionCards();
  }

  /**
   * 交互焦点卡：权限与用户输入统一排队。tab 可点切换查看/作答，提交后原地推进下一条。
   * tab 标签可区分请求（权限 = 工具名 · 理由摘要；输入 = 首 header），不再千篇一律。
   */
  private renderPermissionCards(): void {
    this.messagesEl.querySelectorAll('.permission-card, .user-input-card').forEach((n) => n.remove());

    // 同步队列与登记表（resolved 的条目移出）+ 兜底去重
    this.interactionOrder = this.interactionOrder.filter((e) => {
      if (e.type === 'permission') return this.pendingPermissions.has(e.id);
      return this.pendingUserInputs.has(e.id);
    });
    if (this.interactionOrder.length > 1) {
      const seen = new Set<string>();
      this.interactionOrder = this.interactionOrder.filter((e) => {
        const k = `${e.type}:${e.id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    if (!this.interactionOrder.length) {
      this.ixSelected = 0;
      this.ixHeadId = null;
      this.scrollBottom();
      return;
    }
    this.ixSelected = Math.max(0, Math.min(this.ixSelected, this.interactionOrder.length - 1));

    const focus = this.interactionOrder[this.ixSelected];
    const total = this.interactionOrder.length;

    // tab 标签：输入卡取首 header；权限卡 = 工具名 · 理由摘要（reason 是唯一区分字段）
    const tabLabel = (e: { type: 'permission' | 'input'; id: string }): string => {
      const req = e.type === 'permission' ? this.pendingPermissions.get(e.id) : this.pendingUserInputs.get(e.id);
      if (!req) return '…';
      const qs = ((req.input ?? {}) as { questions?: { header: string }[] }).questions
        ?? ((req as unknown as { questions?: { header: string }[] }).questions ?? []);
      if (qs.length) return qs[0].header + (qs.length > 1 ? ` +${qs.length - 1}` : '');
      if (e.type === 'permission') {
        const p = req as PermissionRequestParams;
        const reason = (p.reason || '').replace(/\s+/g, ' ').trim();
        const text = p.toolName && reason ? `${p.toolName} · ${reason}` : (p.toolName || this.t('permissionNeeded'));
        return text.length > 30 ? text.slice(0, 29) + '…' : text;
      }
      const prompt = (req as { prompt?: string }).prompt;
      if (prompt) return prompt.length > 16 ? prompt.slice(0, 16) + '…' : prompt;
      return this.t('respond');
    };
    const tabs = h('div', { class: 'ix-tabs' });
    this.interactionOrder.forEach((e, i) => {
      tabs.append(h('button', {
        type: 'button',
        class: `ix-tab ${i === this.ixSelected ? 'active' : ''}`,
        title: tabLabel(e),
        onclick: () => {
          if (this.ixSelected !== i) {
            this.ixSelected = i;
            this.renderPermissionCards();
          }
        }
      }, `${i + 1}. ${tabLabel(e)}`));
    });
    if (total > 1) tabs.append(h('span', { class: 'ix-hint' }, `${this.ixSelected + 1}/${total}`));

    if (focus.type === 'permission') {
      const req = this.pendingPermissions.get(focus.id)!;
      let draft = this.ixDrafts.get(req.requestId);
      if (!draft) { draft = createInteractionDraft(); this.ixDrafts.set(req.requestId, draft); }
      const card = renderPermissionCard(req, this.t, draft, (response) => {
        this.pendingPermissions.delete(req.requestId);
        this.ixDrafts.delete(req.requestId);
        this.post({ kind: 'permission-response', requestId: req.requestId, response: response as PermissionResponse });
        this.renderPermissionCards();
      });
      card.prepend(tabs);
      this.messagesEl.append(card);
      this.focusInteractionCard(card, focus);
    } else {
      const req = this.pendingUserInputs.get(focus.id);
      if (!req) {
        this.interactionOrder.shift();
        this.renderPermissionCards();
        return;
      }
      let draft = this.ixDrafts.get(req.requestId);
      if (!draft) { draft = createInteractionDraft(); this.ixDrafts.set(req.requestId, draft); }
      const card = renderUserInputCard(req, this.t, draft, (response) => {
        this.submitUserInput(req.requestId, response as UserInputResponse);
      });
      card.prepend(tabs);
      this.messagesEl.append(card);
      this.focusInteractionCard(card, focus);
    }
    this.scrollBottom();
  }

  /** 队首切换时把焦点交给卡片（键盘导航立即可用）；同卡重渲染不抢用户焦点 */
  private focusInteractionCard(card: HTMLElement, focus: { type: string; id: string }): void {
    const headId = `${focus.type}:${focus.id}`;
    if (this.ixHeadId === headId) return;
    this.ixHeadId = headId;
    card.focus({ preventScroll: true });
  }

  private submitUserInput(requestId: string, response: UserInputResponse): void {
    this.pendingUserInputs.delete(requestId);
    this.ixDrafts.delete(requestId);
    this.post({ kind: 'user-input-response', requestId, response });
    this.renderPermissionCards(); // 队列推进到下一张
  }

  /** 权威上下文窗口：当前模型在 available（配置权威列表）里的值；投影里的 200K 是降级值不可信 */
  private authoritativeWindow(): number {
    const cur = this.session?.settings.model.current;
    const fromModel = cur
      ? this.session?.settings.model.available.find((m) => m.ref.providerId === cur.providerId && m.ref.modelId === cur.modelId)?.contextWindow
      : undefined;
    if (fromModel && fromModel > 0) return fromModel;
    return this.session?.projection.contextWindow ?? 0;
  }

  /** 上下文圆环：SVG 进度环，颜色随占用率绿→黄→橙红 */
  private renderContextRing(): void {
    const proj = this.session?.projection;
    const btn = this.ctxRingBtn;
    const window = this.authoritativeWindow();
    if (!proj || window <= 0) {
      btn.classList.add('hidden');
      btn.innerHTML = '';
      return;
    }
    const used = Math.min(proj.contextUsed, window);
    const pct = Math.round((used / window) * 100);
    const r = 6.5;
    const c = 2 * Math.PI * r;
    const color = pct < 60 ? 'var(--vscode-charts-green)' : pct < 85 ? 'var(--vscode-charts-yellow)' : 'var(--vscode-charts-orange)';
    btn.classList.remove('hidden');
    btn.title = `${this.t('context')} ${pct}% · ${formatTokens(used)}/${fmtContext(window)} ${this.t('tokens')}`;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
<circle cx="8" cy="8" r="${r}" fill="none" stroke="var(--vscode-panel-border,rgba(128,128,128,.35))" stroke-width="2.4"/>
<circle cx="8" cy="8" r="${r}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"
  stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(2)}" transform="rotate(-90 8 8)"/>
</svg>`;
  }

  /** 圆环点击：上下文使用量（窗口尺寸以模型配置为准，非投影降级值） */
  private toggleContextMenu(refresh = false): void {
    if (!refresh && this.isOpenFor(this.ctxRingBtn)) {
      this.hidePopup();
      return;
    }
    if (!refresh) this.hidePopup();
    const proj = this.session?.projection;
    if (!proj) return;
    const window = this.authoritativeWindow();
    const used = Math.min(proj.contextUsed, window);
    const pct = window > 0 ? Math.round((used / window) * 1000) / 10 : 0;
    const list = h('div', { class: 'menu account-menu' });
    list.append(h('div', { class: 'menu-item static' },
      h('span', { class: 'ctx-title' }, this.t('context')),
      h('span', { class: 'menu-item-meta' }, `${formatTokens(used)}/${fmtContext(window)} (${pct}%)`)
    ));
    list.append(h('div', { class: 'ctx-progress' }, h('span', { class: 'ctx-progress-fill', style: `width:${Math.min(100, pct)}%` })));
    // 分来源占比：session.updated 的 contextUsageBreakdown（真实上下文组成，chars）
    if (this.ctxBreakdown?.length) {
      const totalChars = this.ctxBreakdown.reduce((a, b) => a + b.chars, 0);
      if (totalChars > 0) {
        list.append(h('div', { class: 'menu-sep' }));
        for (const e of [...this.ctxBreakdown].sort((a, b) => b.chars - a.chars)) {
          const share = Math.round((e.chars / totalChars) * 1000) / 10;
          list.append(h('div', { class: 'menu-item static' },
            h('span', { class: 'menu-item-label' }, h('span', { class: 'mcp-dot ok' }, '●'), h('span', {}, sourceLabel(e.source))),
            h('span', { class: 'menu-item-meta' }, `${share}% · ${formatTokens(e.chars)}`)
          ));
        }
      }
    }
    this.showPopup(this.ctxRingBtn, list);
  }



  /** 思考指示器（Claude Code 同款动态效果）：盲文旋转符 + 实时耗时秒数，一眼区分"活着"与"卡死" */
  /** 运行态判定：回合运行/等待权限/后台任务任一为真 */
  private isBusyLike(): boolean {
    const st = this.session?.projection.status;
    return st === 'running' || st === 'waiting' || (this.session?.projection.backgroundJobs?.length ?? 0) > 0;
  }

  private renderThinkingState(): void {
    // 常驻策略：回合运行中指示器始终钉在消息流底部（流式/工具间隙都有动效+计时）；
    // 后台任务期间也显示（文案切换），避免"看着空闲其实还在跑"的误判。
    // 动效走 CSS（像素网格 pixel-on + shimmer 文字），计时器只刷秒数
    const active = this.isBusyLike();
    const fgRunning = this.session?.projection.status === 'running' || this.session?.projection.status === 'waiting';
    let thinking = this.messagesEl.querySelector('.thinking-cursor');
    if (active) {
      if (!thinking) {
        thinking = h('div', { class: 'thinking-cursor msg msg-assistant' });
        this.messagesEl.append(thinking);
        this.thinkStart = Date.now();
        const el = thinking;
        // 像素网格加载器（对标 Beautiful UI Loading State）：3×3 圆点错峰点亮
        const grid = h('span', { class: 'think-pixel' });
        for (let i = 0; i < 9; i++) grid.append(h('span', { class: 'think-px', style: `animation-delay:${(i % 3) * 140 + Math.floor(i / 3) * 90}ms` }));
        const label = h('span', { class: 'think-label' },
          fgRunning ? this.t('thinking') : this.t('bgTask'));
        const secs = h('span', { class: 'think-secs' }, '0s');
        el.append(grid, label, secs);
        if (this.thinkTimer) clearInterval(this.thinkTimer);
        this.thinkTimer = setInterval(() => {
          if (!document.body.contains(el)) {
            if (this.thinkTimer) clearInterval(this.thinkTimer);
            this.thinkTimer = undefined;
            return;
          }
          secs.textContent = `${Math.floor((Date.now() - this.thinkStart) / 1000)}s`;
          // 前/后台文案实时切换（状态可能在长任务中变化）
          const nowFg = this.session?.projection.status === 'running' || this.session?.projection.status === 'waiting';
          const text = nowFg ? this.t('thinking') : this.t('bgTask');
          if (label.textContent !== text) label.textContent = text;
        }, 1000);
      }
    } else {
      thinking?.remove();
      if (this.thinkTimer) {
        clearInterval(this.thinkTimer);
        this.thinkTimer = undefined;
      }
    }
  }

  // ═══════════════ 头部 / 状态 / 浮层 ═══════════════

  private renderHeaderControls(): void {
    if (!this.session) {
      // 会话就绪前：模型给通用名，模式给默认值——chips 首帧即真名可点
      this.modelBtn.textContent = 'GLM';
      this.modeBtn.textContent = MODE_CHIP_LABEL[this.defaultMode] ?? this.defaultMode;
      this.titleEl.textContent = this.t('appTitle');
      return;
    }
    const cur = this.session.settings.model.current ?? this.session.settings.model.lastUsed;
    const modelInfo = cur
      ? this.session.settings.model.available.find((m) => m.ref.providerId === cur.providerId && m.ref.modelId === cur.modelId)
      : undefined;
    const modelLabel = cur ? modelInfo?.label ?? cur.modelId : '—';
    // 对标 Claude Code 的 "glm-5.3-flash High"：模型名 + 推理档位
    const level = cur?.options?.reasoningLevel;
    this.modelBtn.textContent = level ? `${modelLabel} ${level[0].toUpperCase()}${level.slice(1)}` : modelLabel;
    const mode = String(this.session.settings.mode.current ?? this.session.projection.mode ?? '');
    this.modeBtn.textContent = '';
    this.modeBtn.append(modeIconEl(mode));
    this.modeBtn.title = MODE_CHIP_LABEL[mode] ?? mode;
    this.titleEl.textContent = this.session.info.title || this.t('appTitle');
  }

  private renderBanner(): void {
    // 对标 Claude Code：启动过程零横幅；失败走自动消失的错误气泡（重试入口在齿轮菜单）；
    // 仅环境缺失（需用户处理配置）保留常驻提示
    this.banner.classList.add('hidden');
    if (!this.environmentOk) {
      this.banner.classList.remove('hidden');
      this.banner.innerHTML = '';
      this.banner.append(h('div', { class: 'banner-error' },
        `⚠ ${this.t('appMissing')}`,
        h('div', { class: 'banner-sub' }, this.environmentDetail ?? this.t('appMissingHint'))
      ));
    } else if (this.serverState === 'failed') {
      this.showError(`${this.t('serverFailed')}${this.serverDetail ? `: ${this.serverDetail}` : ''}`);
    }
    this.renderOverlay();
  }

  private renderOverlay(): void {
    this.overlayEl.innerHTML = '';
    if (!this.environmentOk) return; // banner 已提示
    if (this.account && !this.account.loggedIn) {
      this.messagesEl.style.display = 'none'; // 未登录必然无会话，收起消息区让登录门垂直居中
      this.overlayEl.append(h('div', { class: 'gate' },
        h('div', { class: 'gate-logo' }, 'Z'),
        h('div', { class: 'gate-title' }, this.t('loginRequired')),
        h('div', { class: 'gate-hint' }, this.t('loginHint')),
        h('button', { class: 'gate-btn', onclick: () => this.post({ kind: 'login' }) }, this.t('login'))
      ));
      this.overlayEl.classList.add('visible');
      return;
    }
    // 空会话即刻呈现欢迎页（不依赖草稿会话建立）：服务启动中显示启动提示
    if (this.messages.size === 0) {
      const idx = this.locale === 'zh-CN' ? 'zh' : 'en';
      this.overlayEl.append(h('div', { class: 'gate subtle' },
        h('div', { class: 'gate-logo small', style: 'background:#18181a' }, zLogoEl()),
        h('div', { class: 'gate-title' }, this.t('emptyTitle')),
        h('div', { class: 'gate-hint' }, this.serverState === 'starting' ? this.t('starting') : this.t('emptyHint')),
        h('div', { class: 'gate-suggestions' },
          ...SUGGESTIONS.map((s) => h('button', { class: 'gate-suggestion', onclick: () => { this.composerInput.value = s[idx]; this.composerInput.focus(); } }, s[idx]))
        )
      ));
      this.messagesEl.style.display = 'none'; // 空消息区收起，欢迎区垂直居中
      this.overlayEl.classList.add('visible');
      return;
    }
    this.messagesEl.style.display = '';
    this.overlayEl.classList.remove('visible');
  }

  private renderStatus(): void {
    this.updateSendAffordance();
    this.renderContextRing();
  }

  /**
   * 发送按钮供能规则（对标 Claude Code）：
   * 输入框有内容（文字/附件）→ 发送态（点击=入队发送）
   * 输入框为空且回合运行中 → 停止态（点击=中止）
   * 其余 → 发送态
   */
  private updateSendAffordance(): void {
    const running = this.isBusyLike();
    const hasContent = this.composerInput.value.trim().length > 0 || this.attachments.length > 0;
    const stopArmed = running && !hasContent;
    if (stopArmed) {
      this.sendBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="currentColor"/></svg>';
      this.sendBtn.title = this.t('stop');
    } else {
      this.sendBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 2.2 14 8 3.2 13.8z" fill="currentColor"/></svg>';
      this.sendBtn.title = this.t('send');
    }
    this.sendBtn.classList.toggle('stop', stopArmed);
  }


  private showError(message: string): void {
    const existing = this.messagesEl.querySelector('.error-toast');
    existing?.remove();
    this.messagesEl.append(h('div', { class: 'error-toast' }, `⚠ ${esc(message)}`));
    this.scrollBottom();
    setTimeout(() => this.messagesEl.querySelector('.error-toast')?.remove(), 8000);
  }

  // ═══════════════ 菜单 ═══════════════

  private showPopup(anchor: HTMLElement, content: HTMLElement): void {
    this.popupAnchor = anchor;
    this.popupEl.innerHTML = '';
    this.popupEl.append(content);
    this.popupEl.classList.remove('hidden');
    const rect = anchor.getBoundingClientRect();
    // 渲染后实测弹窗尺寸，左右上下全部钳制在视口内、并贴齐锚点侧
    const w = this.popupEl.offsetWidth;
    let left = rect.left;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    this.popupEl.style.left = `${Math.max(8, left)}px`;
    if (rect.top > window.innerHeight / 2) {
      // 锚点在下半屏（composer chips）→ 向上弹出
      this.popupEl.style.top = 'auto';
      this.popupEl.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    } else {
      this.popupEl.style.bottom = 'auto';
      this.popupEl.style.top = `${Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - this.popupEl.offsetHeight - 8))}px`;
    }
  }

  private hidePopup(): void {
    this.popupEl.classList.add('hidden');
    this.popupAnchor = null;
    this.slashIndex = -1;
    this.sessionsMenuOpen = false;
    this.atDir = '';
  }
  /** 菜单是否正锚定在该按钮上打开 */
  private isOpenFor(anchor: HTMLElement): boolean {
    return !this.popupEl.classList.contains('hidden') && this.popupAnchor === anchor;
  }

  private toggleModelMenu(): void {
    if (this.isOpenFor(this.modelBtn)) {
      this.hidePopup();
      return;
    }
    this.hidePopup();
    const models = this.session?.settings.model.available ?? [];
    const current = this.session?.settings.model.current;
    const groups = new Map<string, AvailableModel[]>();
    for (const m of models) {
      const key = m.providerLabel ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    const list = h('div', { class: 'menu' });
    for (const [group, items] of groups) {
      list.append(h('div', { class: 'menu-group' }, group));
      for (const m of items) {
        const selected = current?.providerId === m.ref.providerId && current?.modelId === m.ref.modelId;
        const row = h('div', { class: `menu-item ${selected ? 'selected' : ''}` },
          h('span', { class: 'menu-item-label' },
            h('span', {}, m.label),
            h('span', { class: 'menu-item-meta' }, `${fmtContext(m.contextWindow)}`)
          ),
          m.reasoning
            ? h('span', { class: 'reasoning-levels' },
                ...m.reasoning.levels.map((lv) =>
                  h('button', {
                    class: `lv-btn ${selected && current?.options?.reasoningLevel === lv.value ? 'active' : ''}`,
                    title: `${this.t('reasoning')}: ${lv.label}`,
                    onclick: () => {
                      this.optimisticSetModel(m.ref.providerId, m.ref.modelId, lv.value);
                      this.post({ kind: 'set-model', providerId: m.ref.providerId, modelId: m.ref.modelId, reasoningLevel: lv.value });
                      this.hidePopup();
                    }
                  }, lv.label[0].toUpperCase())
                )
              )
            : null
        );
        row.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('.lv-btn')) return;
          const lvl = m.reasoning && selected ? current?.options?.reasoningLevel : m.reasoning?.defaultLevel;
          this.optimisticSetModel(m.ref.providerId, m.ref.modelId, lvl);
          this.post({ kind: 'set-model', providerId: m.ref.providerId, modelId: m.ref.modelId, reasoningLevel: lvl });
          this.hidePopup();
        });
        list.append(row);
      }
    }
    if (!models.length) {
      const connecting = this.serverState === 'starting' || this.serverState === 'stopped';
      list.append(h('div', { class: 'menu-empty' }, connecting ? this.t('starting') : '—'));
    }
    this.showPopup(this.modelBtn, list);
  }

  // ═══════════════ 附件与 @ 引用 ═══════════════

  /** 排队管理器：每条显示全文 + 立即发送（插队）+ 删除 */
  private renderQueued(): void {
    this.queuedEl.innerHTML = '';
    if (this.queuedCount <= 0 || !this.queuedItems.length) {
      this.queuedCount = 0;
      this.queuedItems = [];
      this.queuedEl.classList.add('hidden');
      return;
    }
    this.queuedEl.classList.remove('hidden');
    for (const q of this.queuedItems) {
      this.queuedEl.append(h('div', { class: 'queued-item' },
        h('div', { class: 'queued-text', title: q.content }, q.content),
        h('div', { class: 'queued-actions' },
          h('button', {
            class: 'queued-btn primary',
            title: this.t('sendNow'),
            onclick: () => this.post({ kind: 'prioritize-queue-item', id: q.id })
          }, this.t('sendNow')),
          h('button', {
            class: 'queued-btn',
            title: this.t('cancel'),
            onclick: () => this.post({ kind: 'remove-queue-item', id: q.id })
          }, '×')
        )
      ));
    }
  }

  private renderAttachRow(): void {
    this.attachRow.innerHTML = '';
    if (!this.attachments.length) {
      this.attachRow.classList.add('hidden');
      return;
    }
    this.attachRow.classList.remove('hidden');
    for (const a of this.attachments) {
      const isImg = Boolean(a.dataUrl) || a.mime?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name);
      const preview = isImg && a.dataUrl
        ? h('img', { class: 'attach-thumb', src: a.dataUrl, alt: '' })
        : null;
      this.attachRow.append(h('span', { class: 'attach-chip', title: a.path },
        preview,
        h('span', { class: 'attach-chip-name' }, a.name),
        h('button', { class: 'attach-chip-x', title: this.t('cancel'), onclick: () => {
          this.attachments = this.attachments.filter((x) => x !== a);
          this.renderAttachRow();
          this.updateSendAffordance();
        } }, '×')
      ));
    }
  }

  /** @ 引用：输入框插入 @ 并弹出工作区文件过滤列表 */
  private onAtReference(): void {
    const input = this.composerInput;
    input.focus();
    const at = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, at) + '@' + input.value.slice(input.selectionEnd ?? at);
    input.setSelectionRange(at + 1, at + 1);
    this.onInput();
  }

  /** @ 引用弹层：目录浏览器——文件夹下钻、文件插入引用 */
  private renderAtPopup(): void {
    const input = this.composerInput;
    const m = /@([^@\s]*)$/.exec(input.value.slice(0, input.selectionStart ?? input.value.length));
    if (!m) {
      this.hidePopup();
      return;
    }
    const query = m[1];
    // 输入含路径分隔 → 解析出目标目录与过滤词
    const slash = query.lastIndexOf('/');
    const dirPart = slash >= 0 ? query.slice(0, slash) : '';
    const filterPart = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase();
    if (this.dirEntries?.dir !== dirPart) {
      this.atDir = dirPart;
      this.post({ kind: 'list-files', dir: dirPart });
      this.showPopup(input, h('div', { class: 'menu' }, h('div', { class: 'menu-empty' }, '…')));
      this.popupEl.classList.add('slash');
      return;
    }
    const entries = (this.dirEntries?.dir === this.atDir ? this.dirEntries.entries : null) ?? [];
    const matches = entries.filter((e) => e.name.toLowerCase().includes(filterPart)).slice(0, 14);
    const list = h('div', { class: 'menu at-menu' });
    list.append(h('div', { class: 'menu-group at-crumbs' }, this.atDir ? `@${this.atDir}/` : '@'));
    // 返回上级
    if (this.atDir) {
      list.append(h('div', {
        class: 'menu-item slash-item',
        onclick: () => this.navigateAt(this.atDir.includes('/') ? this.atDir.slice(0, this.atDir.lastIndexOf('/')) : '')
      }, h('span', { class: 'slash-name' }, '📁 ..')));
    }
    if (!matches.length && !this.atDir) {
      list.append(h('div', { class: 'menu-empty' }, this.t('noResults')));
    }
    for (const e of matches) {
      if (e.kind === 'dir') {
        const dir = this.atDir ? `${this.atDir}/${e.name}` : e.name;
        list.append(h('div', {
          class: 'menu-item slash-item',
          onclick: () => this.navigateAt(dir)
        }, h('span', { class: 'slash-name' }, `📁 ${e.name}`)));
      } else {
        const file = this.atDir ? `${this.atDir}/${e.name}` : e.name;
        list.append(h('div', {
          class: 'menu-item slash-item',
          onclick: () => {
            input.value = input.value.replace(/@([^@\s]*)$/, `@${file} `);
            this.hidePopup();
            input.focus();
          }
        }, h('span', { class: 'slash-name' }, `📄 ${e.name}`)));
      }
    }
    this.showPopup(input, list);
    this.popupEl.classList.add('slash');
    this.slashIndex = -1;
  }

  /** 下钻/返回目录：重写输入中的 @ 前缀并刷新列表 */
  private navigateAt(dir: string): void {
    const input = this.composerInput;
    input.value = input.value.replace(/@([^@\s]*)$/, `@${dir ? dir + '/' : ''}`);
    const pos = input.value.length;
    input.setSelectionRange(pos, pos);
    this.atDir = dir;
    this.dirEntries = null;
    this.post({ kind: 'list-files', dir });
    this.showPopup(input, h('div', { class: 'menu' }, h('div', { class: 'menu-empty' }, '…')));
    this.popupEl.classList.add('slash');
    input.focus();
  }

  // ═══════════════ 配置收纳（齿轮弹层，对标 Claude Code settings 菜单） ═══════════════

  private toggleSettingsMenu(): void {
    if (this.isOpenFor(this.gearBtn)) {
      this.hidePopup();
      return;
    }
    this.hidePopup();
    const list = h('div', { class: 'menu' });
    const item = (label: string, onclick: () => void) =>
      list.append(h('div', { class: 'menu-item', onclick: () => { this.hidePopup(); onclick(); } }, h('span', {}, label)));
    if (this.serverState === 'failed') {
      item(this.t('retry'), () => this.post({ kind: 'retry-server' }));
    }
    // 30 天用量（usage/stats 由会话建立/回合结束后推送，此处只读最新值）
    list.append(h('div', { class: 'menu-item static' },
      h('span', {}, this.t('usage')),
      h('span', { class: 'menu-item-meta' }, this.usage ? `${this.usage.range} · ${formatTokens(this.usage.totalTokens)} ${this.t('tokens')}` : '…')
    ));
    item(this.t('mcpServers'), () => {
      this.mcpServers = null;
      this.showPopup(this.gearBtn, h('div', { class: 'menu' }, h('div', { class: 'menu-empty' }, '…')));
      this.post({ kind: 'mcp-servers' });
    });
    item(this.t('commands'), () => { this.composerInput.value = '/'; this.composerInput.focus(); this.onInput(); });
    this.showPopup(this.gearBtn, list);
  }


  private renderMcpMenu(): void {
    // 名称真相源：process/childProcesses（mcp/list 报 workspace 池恒 disconnected，不可用）
    const list = h('div', { class: 'menu mcp-menu' });
    const m = this.mcp;
    const servers = this.mcpServers;
    if (!servers) {
      list.append(h('div', { class: 'menu-empty' }, '…'));
    } else if (!servers.length) {
      list.append(h('div', { class: 'menu-empty' }, this.t('noResults')));
    } else {
      if (m?.done && m.configuredCount) {
        list.append(h('div', { class: 'menu-group' },
          `${this.t('mcpReady')} · ${m.connectedCount ?? 0}/${m.configuredCount ?? 0}${(m.failedCount ?? 0) ? ` · ⚠ ${m.failedCount}` : ''}`));
      }
      for (const sv of servers) {
        list.append(h('div', { class: 'menu-item static', title: `${sv.name} · pid ${sv.pid}` },
          h('span', { class: 'menu-item-label' },
            h('span', { class: 'mcp-dot ok' }, '●'),
            h('span', { class: 'mcp-server-name' }, sv.name)
          ),
          h('span', { class: 'menu-item-meta' }, this.t('mcpConnected'))
        ));
      }
    }
    this.showPopup(this.gearBtn, list);
    if (!servers) this.post({ kind: 'mcp-servers' });
  }



  private toggleModeMenu(): void {
    if (this.isOpenFor(this.modeBtn)) {
      this.hidePopup();
      return;
    }
    this.hidePopup();
    const cur = String(this.session?.settings.mode.current ?? this.session?.projection.mode ?? '');
    const list = h('div', { class: 'menu mode-menu' });
    list.append(h('div', { class: 'menu-group' }, this.t('modes')));
    // 菜单永远可开：四模式是静态选项，不依赖会话数据（图标与 chip 共用 MODE_ICONS）
    // 命名与描述对齐 ZCode 桌面端：计划模式/变更前确认/自动编辑/完全访问
    const NAMES: Record<string, { zh: string; en: string }> = {
      plan: { zh: '计划模式', en: 'Plan' },
      build: { zh: '变更前确认', en: 'Confirm changes' },
      edit: { zh: '自动编辑', en: 'Auto edit' },
      yolo: { zh: '完全访问', en: 'Full access' }
    };
    const DESCS: Record<string, { zh: string; en: string }> = {
      plan: { zh: '编辑前先出计划。', en: 'Present a plan before editing.' },
      build: { zh: '改文件前先问我。', en: 'Ask me before changing files.' },
      edit: { zh: '自动编辑文件。', en: 'Edit files automatically.' },
      yolo: { zh: '减少确认次数。', en: 'Fewer confirmations.' }
    };
    const zh = this.locale === 'zh-CN';
    for (const mode of ['plan', 'build', 'edit', 'yolo'] as const) {
      const icon = h('span', { class: 'mode-icon' });
      icon.innerHTML = MODE_ICONS[mode] ?? '';
      const row = h('div', { class: `menu-item mode-item ${cur === mode ? 'selected' : ''}`, onclick: () => { this.post({ kind: 'set-mode', mode }); this.hidePopup(); } },
        icon,
        h('div', { class: 'mode-text' },
          h('div', { class: 'mode-name' }, zh ? NAMES[mode].zh : NAMES[mode].en),
          h('div', { class: 'mode-desc' }, zh ? DESCS[mode].zh : DESCS[mode].en)
        ),
        cur === mode ? h('span', { class: 'mode-check' }, '✓') : null
      );
      list.append(row);
    }
    // ── Effort 行：当前模型 reasoning 档位 → 圆点（图四同款） ──
    const curSel = this.session?.settings.model.current ?? this.session?.settings.model.lastUsed;
    const modelInfo = curSel
      ? this.session?.settings.model.available.find((m) => m.ref.providerId === curSel.providerId && m.ref.modelId === curSel.modelId)
      : undefined;
    const levels = modelInfo?.reasoning?.levels ?? [];
    if (levels.length) {
      const current = curSel?.options?.reasoningLevel ?? modelInfo?.reasoning?.defaultLevel ?? levels[levels.length - 1].value;
      const currentIdx = Math.max(0, levels.findIndex((l) => l.value === current));
      list.append(h('div', { class: 'menu-sep' }));
      const dots = h('div', { class: 'effort-dots' },
        ...levels.map((lv, i) => h('button', {
          class: `effort-dot ${i <= currentIdx ? 'on' : ''}`,
          title: lv.label,
          onclick: () => {
            if (curSel) {
              this.optimisticSetModel(curSel.providerId, curSel.modelId, lv.value);
              this.post({ kind: 'set-model', providerId: curSel.providerId, modelId: curSel.modelId, reasoningLevel: lv.value });
            }
            this.hidePopup();
          }
        }))
      );
      list.append(h('div', { class: 'menu-item static effort-row' },
        h('span', { class: 'effort-label' }, `${this.t('effort')} (${levels[currentIdx]?.label ?? current})`),
        dots
      ));
    }
    this.showPopup(this.modeBtn, list);
  }


  /** 历史会话下拉（Claude Code 同款：时钟按钮 → 会话列表 → 点击 resume） */
  private toggleSessionsMenu(): void {
    if (this.isOpenFor(this.historyBtn)) {
      this.hidePopup();
      return;
    }
    this.hidePopup();
    this.sessionsMenuOpen = true;
    this.showPopup(this.historyBtn, h('div', { class: 'menu' }, h('div', { class: 'menu-empty' }, '…')));
    this.post({ kind: 'list-sessions' });
  }

  private renderSessionsMenu(sessions: { sessionId: string; title: string; updatedAt: number; mode: string; status: string }[]): void {
    if (!this.sessionsMenuOpen) return;
    const list = h('div', { class: 'menu' });
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
    if (!sorted.length) {
      list.append(h('div', { class: 'menu-empty' }, this.t('noSessions')));
    }
    for (const s of sorted) {
      list.append(h('div', {
        class: 'menu-item session-menu-item',
        onclick: () => {
          this.post({ kind: 'resume', sessionId: s.sessionId });
          this.hidePopup();
        }
      },
        h('span', { class: 'session-menu-title' }, s.title || '(untitled)'),
        h('span', { class: 'menu-item-meta' },
          `${s.mode} · ${relTime(s.updatedAt, this.t)}${s.status === 'running' ? ' ●' : ''}`)
      ));
    }
    this.popupEl.innerHTML = '';
    this.popupEl.append(list);
  }

  // ═══════════════ 输入 ═══════════════

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.previewEl) {
      this.closePreview();
      return;
    }
    const popupOpen = !this.popupEl.classList.contains('hidden') && this.popupEl.classList.contains('slash');
    if (popupOpen) {
      const items = [...this.popupEl.querySelectorAll('.menu-item')] as HTMLElement[];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.slashIndex = e.key === 'ArrowDown'
          ? (this.slashIndex + 1) % items.length
          : (this.slashIndex - 1 + items.length) % items.length;
        items.forEach((it, i) => it.classList.toggle('hover', i === this.slashIndex));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && this.slashIndex >= 0) {
        e.preventDefault();
        items[this.slashIndex]?.click();
        return;
      }
      if (e.key === 'Escape') {
        this.hidePopup();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.onSend();
    }
  }

  private onInput(): void {
    const input = this.composerInput;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    this.updateSendAffordance();
    const v = input.value;
    const atMatch = /@([^@\s]*)$/.exec(v.slice(0, input.selectionStart ?? v.length));
    if (atMatch) {
      this.renderAtPopup();
      return;
    }
    if (v.startsWith('/')) {
      const query = v.slice(1).split(' ')[0].toLowerCase();
      const cmds = (this.session?.slashCommands ?? []).filter((c) => c.name.startsWith(query));
      if (cmds.length) this.showSlashPopup(cmds);
      else this.hidePopup();
    } else {
      this.hidePopup();
    }
  }

  private showSlashPopup(cmds: SlashCommand[]): void {
    const list = h('div', { class: 'menu' });
    for (const c of cmds.slice(0, 10)) {
      list.append(h('div', {
        class: 'menu-item slash-item',
        onclick: () => {
          this.composerInput.value = `/${c.name} `;
          this.hidePopup();
          this.composerInput.focus();
          this.onInput();
        }
      },
      h('span', { class: 'slash-name' }, `/${c.name}`),
      h('span', { class: 'menu-item-meta' }, c.description.slice(0, 60))
      ));
    }
    this.showPopup(this.composerInput, list);
    this.popupEl.classList.add('slash');
    this.slashIndex = -1;
  }

  private onSend(): void {
    // 停止态判定：运行中/后台任务中且输入框为空 → 点击=中止
    const running = this.isBusyLike();
    const hasContent = this.composerInput.value.trim().length > 0 || this.attachments.length > 0;
    if (running && !hasContent) {
      this.post({ kind: 'stop' });
      return;
    }
    const text = this.composerInput.value.trim();
    if (!text) return;
    this.composerInput.value = '';
    this.composerInput.style.height = 'auto';
    this.hidePopup();
    const attachments = this.attachments.slice();
    this.attachments = [];
    this.renderAttachRow();
    this.post({ kind: 'send', content: text, attachments: attachments.length ? attachments : undefined });
    // 乐观渲染统一由 controller 的 optimistic-user 承担（受理后即时显示，防双份）
  }

  /** 附件芯片点击：统一走 lightbox（图片放大预览；无数据时提示） */
  private onAttachmentClick(name: string, url?: string, _isImg?: boolean): void {
    this.openPreview(name, url);
  }

  /** 回填消息内图片附件的缩略图 src（registry 命中时）——每次渲染后调用 */
  private hydrateAttachmentThumbs(): void {
    this.messagesEl.querySelectorAll('.msg-attachment-img .msg-attach-thumb').forEach((img) => {
      const el = img as HTMLImageElement;
      if (el.src) return;
      const chip = el.closest('.msg-attachment-img') as HTMLElement | null;
      const name = chip?.querySelector('.attach-chip-name')?.textContent ?? '';
      const data = this.previewRegistry.get(name);
      if (data) el.src = data;
    });
  }

  /** 附件预览 lightbox：点击聊天里的附件芯片弹出大图（Esc/点击背景关闭） */
  private openPreview(name: string, url?: string): void {
    const src = this.previewRegistry.get(name)
      ?? (url && /^(data:|https?:)/.test(url) ? url : undefined);
    this.closePreview();
    if (!src) {
      this.showError(this.locale === 'zh-CN' ? '该附件无预览数据' : 'No preview data for this attachment');
      return;
    }
    const isImg = /^data:image\//.test(src) || /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(url ?? name) || this.previewRegistry.has(name);
    const box = h('div', { class: 'preview-backdrop' });
    const body = isImg
      ? h('img', { class: 'preview-img', src, alt: name })
      : h('iframe', { class: 'preview-frame', src, title: name });
    const close = h('button', { class: 'preview-close', title: this.t('cancel') }, '×');
    (close as HTMLElement).addEventListener('click', (e) => { e.stopPropagation(); this.closePreview(); });
    (box as HTMLElement).addEventListener('click', () => this.closePreview());
    (body as HTMLElement).addEventListener('click', (e) => e.stopPropagation());
    box.append(body, close, h('div', { class: 'preview-name' }, name));
    this.root.append(box);
    this.previewEl = box;
    box.focus?.();
  }

  private closePreview(): void {
    this.previewEl?.remove();
    this.previewEl = null;
  }

  private isNearBottom(): boolean {
    const el = this.messagesEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  private scrollBottom(): void {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }
}

// ═══════════════ 适配工具 ═══════════════

function extractMessage(ev: SessionEvent, payload?: Record<string, unknown>): { id: string; msg: MutableSessionMessage } | null {
  const anyEv = ev as unknown as Record<string, unknown>;
  const source = (payload ?? {}) as Record<string, unknown>;
  const hasParts = source.parts != null || anyEv.parts != null;
  const raw = (source.message ?? anyEv.message ?? hasParts ? { ...source } : anyEv) as Record<string, unknown>;
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

/** 工具结果对象 → 展示文本（宽容尝试多种字段） */
function extractToolResultText(result: Record<string, unknown> | undefined): string | null {
  if (!result || typeof result !== 'object') return null;
  for (const k of ['output', 'content', 'summary', 'text', 'display', 'stdout']) {
    const v = result[k];
    if (typeof v === 'string' && v) return v;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return null;
  }
}

/** 官方 Z 标（对齐桌面端 icon 的斜切双段 Z） */
function zLogoEl(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-svg';
  span.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5.4" fill="transparent"/><g fill="#fff"><rect x="6.1" y="6.9" width="11.8" height="1.5"/><rect x="6.1" y="15.6" width="11.8" height="1.5"/><polygon points="16.4,8.4 17.8,8.4 7.5,15.6 6.1,15.6"/></g><polygon points="12.4,4.5 13.2,4.5 12,19.5 11.2,19.5" fill="#18181a"/></svg>';
  return span;
}

/** 模式图标（chip 与菜单共用，随 currentColor 着色） */
function modeIconEl(mode: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-svg';
  span.innerHTML = MODE_ICONS[mode] ?? MODE_ICONS.build;
  return span;
}

/** @ 引用图标 */
function atIconEl(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-svg';
  span.style.fontWeight = '600';
  span.textContent = '@';
  span.style.fontSize = '12px';
  return span;
}

/** 齿轮图标（配置收纳入口） */
function gearIconEl(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-svg';
  span.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  return span;
}

/** 新建会话图标（内联 SVG） */
function plusIconEl(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-svg';
  span.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  return span;
}

/** 上下文来源键 → 人话标签 */
function sourceLabel(src: string): string {
  const MAP: Record<string, string> = {
    system_prompt: 'System prompt',
    meta_user_context: 'User context',
    skills: 'Skills',
    tool_prompt: 'Tools',
    system_tool_schemas: 'Tool schemas',
    mcp_tool_schemas: 'MCP schemas',
    messages: 'Messages'
  };
  return MAP[src] ?? src;
}

/** 头部时钟图标（内联 SVG，随 currentColor 主题着色） */
function clockIconEl(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-svg';
  span.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6V8l2.3 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  return span;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtContext(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(0)}M` : `${Math.round(n / 1000)}K`;
}
