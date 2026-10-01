/**
 * [INPUT]: 消费 ../../protocol/types、../bridge 契约、./render、./i18n；委托 ./events（协议事件适配）、./queue（交互焦点队列）、./menus（弹层菜单）、./todoPanel（进程面板渲染）、./icons、./format
 * [OUTPUT]: 对外提供 ChatApp（webview 聊天应用：状态机 + 应用壳 + 桥接消息入口；EventHost/QueueHost/MenuHost 的宿主实现）；含 diff 式 rebuildMessages（快照复用节点 + 流式消息跳过，根治全量重建闪烁）
 * [POS]: webview 的中枢——持有全部共享状态，事件适配/交互队列/菜单/进程面板渲染委托给子模块；slash/@ 弹层因需改写输入框文本留在本层
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type {
  SessionMessage,
  MessagePart,
  SessionSettings,
  PermissionRequestParams,
  UserInputRequestParams
} from '../../protocol/types';
import type { ToWebviewMessage, FromWebviewMessage, BootstrapPayload, DirEntry, AttachmentRef } from '../bridge';
import { h, renderMessage, esc, resetToolCollapseState } from './render';
import type { InteractionDraft } from './interaction';
import { makeT, type Locale, type Translate } from './i18n';
import { zLogoEl, modeIconEl, atIconEl, gearIconEl, plusIconEl, clockIconEl } from './icons';
import { formatTokens, fmtContext } from './format';
import { applySessionEvent, normalizeMessageId, type ChatSessionState, type MutableSessionMessage } from './events';
import { renderPermissionCards } from './queue';
import { MenuController } from './menus';
import { extractLatestTodos, renderTodoPanel as renderTodoPanelDom } from './todoPanel';

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

export class ChatApp {
  // ═══════════ 子模块宿主面（public：./events ./queue ./menus 经 Host 接口访问） ═══════════
  t: Translate;
  locale: Locale = 'en-US';
  environmentOk = true;
  environmentDetail: string | undefined;
  account: BootstrapPayload['account'] = null;
  serverState = 'stopped';
  defaultMode = 'build';
  serverDetail: string | undefined;
  session: ChatSessionState | null = null;
  messages = new Map<string, MutableSessionMessage>();
  dirty = new Set<string>();
  pendingPermissions = new Map<string, PermissionRequestParams>();
  pendingUserInputs = new Map<string, UserInputRequestParams>();
  /** 交互卡草稿（键 = requestId，两通道共用——CLI 会在两通道复用同一 requestId）：重渲染不丢已答内容与向导进度 */
  ixDrafts = new Map<string, InteractionDraft>();
  /** 当前拥有焦点的交互卡（type:id）——只在队首切换时抢焦点，重渲染不偷 */
  ixHeadId: string | null = null;
  flushScheduled = false;
  vscodeApi: { postMessage(msg: FromWebviewMessage): void } | undefined;

  // DOM 引用
  root!: HTMLElement;
  banner!: HTMLElement;
  messagesEl!: HTMLElement;
  composerInput!: HTMLTextAreaElement;
  sendBtn!: HTMLButtonElement;
  modelBtn!: HTMLButtonElement;
  modeBtn!: HTMLButtonElement;
  titleEl!: HTMLElement;
  overlayEl!: HTMLElement;
  todoPanelEl!: HTMLElement;
  attachRow!: HTMLElement;
  queuedEl!: HTMLElement;
  queuedCount = 0;
  queuedItems: { id: string; content: string }[] = [];
  /** 交互焦点队列：权限卡与用户输入卡统一排队，tab 可点切换，一次亮一张 */
  interactionOrder: { type: 'permission' | 'input'; id: string }[] = [];
  /** 当前展示的队列位次（tab 点击切换；提交后原地指向下一条） */
  ixSelected = 0;
  thinkTimer: ReturnType<typeof setInterval> | undefined;
  thinkStart = 0;
  pasteSeq = 0;
  previewRegistry = new Map<string, string>();
  pastePending = new Map<string, string>();
  previewEl: HTMLElement | null = null;
  ctxBreakdown: { source: string; chars: number }[] | null = null;
  /** 用户关闭的进程面板任务（记 TodoWrite callId——仅同任务隐藏，新一轮任务自动重现；会话切换重置） */
  todoClosedCallId: string | null = null;
  /** 消息渲染快照（id → 内容指纹）：rebuild diff 复用节点，未变化的消息不重建——全量重建是消息流闪烁根因 */
  private rendered = new Map<string, string>();

  private snapshotOf(m: MutableSessionMessage): string {
    return `${JSON.stringify(m.info)}\u0000${JSON.stringify(m.parts)}`;
  }

  // 上下文快照（used/window/breakdown）按 sessionId 落 localStorage——这些值只随回合中段的
  // session.updated 推送（协议无拉取口），webview 重载/resume 后弹层与圆环仍能展示最后一次已知值
  setCtxBreakdown(items: { source: string; chars: number }[]): void {
    this.ctxBreakdown = items;
  }

  saveCtxSnapshot(): void {
    const proj = this.session?.projection as { contextUsed?: number; contextWindow?: number } | undefined;
    const sid = this.session?.info.sessionId;
    if (!sid || !proj || !this.ctxBreakdown?.length) return;
    try {
      localStorage.setItem(`zcode.ctxSnapshot.${sid}`, JSON.stringify(
        { used: proj.contextUsed, win: proj.contextWindow, breakdown: this.ctxBreakdown }));
    } catch { /* 配额满/隐私模式静默 */ }
  }

  private loadCtxSnapshot(sessionId: string): void {
    try {
      const raw = localStorage.getItem(`zcode.ctxSnapshot.${sessionId}`);
      if (!raw) return;
      const s = JSON.parse(raw) as { used?: number; win?: number; breakdown?: { source: string; chars: number }[] };
      if (Array.isArray(s.breakdown)) this.ctxBreakdown = s.breakdown;
      const proj = this.session?.projection as Record<string, unknown> | undefined;
      if (!proj) return;
      if (typeof s.used === 'number' && s.used > 0) { proj.contextUsed = s.used; proj.totalTokenCount = s.used; }
      if (typeof s.win === 'number' && s.win > 0) proj.contextWindow = s.win;
    } catch { /* 脏数据忽略 */ }
  }

  historyBtn!: HTMLButtonElement;
  gearBtn!: HTMLButtonElement;
  ctxRingBtn!: HTMLButtonElement;
  slashIndex = -1;
  attachments: AttachmentRef[] = [];
  atDir = '';
  dirEntries: { dir: string; entries: DirEntry[] } | null = null;
  sessionsMenuOpen = false;
  currentAssistantId: string | null = null;
  mcp: { started: number; done: boolean; configuredCount?: number; connectedCount?: number; failedCount?: number; servers?: string[]; crashed?: string[] } | null = null;
  mcpServers: { name: string; pid: number; source: string }[] | null = null;
  private menus!: MenuController;

  constructor() {
    this.t = makeT('en-US');
  }

  mount(root: HTMLElement): void {
    this.root = root;
    root.innerHTML = '';
    this.menus = new MenuController(this);
    this.buildShell();
  }

  setApi(api: { postMessage(msg: FromWebviewMessage): void }): void {
    this.vscodeApi = api;
  }

  post(msg: FromWebviewMessage): void {
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
    this.todoPanelEl = h('div', { class: 'todo-panel hidden' });

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
      this.todoPanelEl,
      this.menus.popupEl,
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
          const id = normalizeMessageId(m as MutableSessionMessage) || `m-${this.messages.size}`;
          this.messages.set(id, m as MutableSessionMessage);
        }
        this.pendingPermissions.clear();
        this.pendingUserInputs.clear();
        this.ixDrafts.clear();
        this.ixHeadId = null;
        this.mcp = null;
        this.rendered.clear();
        this.todoClosedCallId = null;
        this.loadCtxSnapshot(d.session.sessionId);
        this.rebuildMessages();
        this.hydrateAttachmentThumbs();
        this.renderHeaderControls();
        this.renderOverlay();
        this.renderStatus();
        break;
      }
      case 'session-closed':
        resetToolCollapseState();
        if (this.session) {
          try { localStorage.removeItem(`zcode.ctxSnapshot.${this.session.info.sessionId}`); } catch { /* 同上 */ }
        }
        this.session = null;
        this.messages.clear();
        this.pendingPermissions.clear();
        this.pendingUserInputs.clear();
        this.ixDrafts.clear();
        this.ixHeadId = null;
        this.mcp = null;
        this.ctxBreakdown = null;
        this.rendered.clear();
        this.todoClosedCallId = null;
        this.queuedCount = 0;
        this.queuedItems = [];
        this.renderQueued();
        this.rebuildMessages();
        this.renderHeaderControls();
        this.renderOverlay();
        break;
      case 'session-event':
        applySessionEvent(this, msg.data);
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
        this.menus.renderSessionsMenu(msg.data.sessions);
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
          const id = normalizeMessageId(m as MutableSessionMessage) || `m-${this.messages.size}`;
          // 服务端部件无 partId、callId 写作 callID——归一化（折叠记忆/增量更新依赖 partId）
          (m as MutableSessionMessage).parts = (m.parts ?? []).map((pp, i) => ({
            ...pp,
            partId: (pp as { partId?: string }).partId ?? `${id}-p${i}`,
            callId: (pp as { callId?: string }).callId ?? (pp as { callID?: string }).callID
          } as MessagePart));
          this.messages.set(id, m as MutableSessionMessage);
        }
        // 回合运行中保留流式消息 id：rebuild 的"流式消息跳过重建"依赖它识别；
        // 回合结束（status 已归 idle）才复位——下轮重建走 markdown 权威渲染
        if (this.session?.projection.status !== 'running') this.currentAssistantId = null;
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

  /** 乐观更新当前模型/档位（patch 回流前 chip 即时反馈） */
  optimisticSetModel(providerId: string, modelId: string, reasoningLevel?: string): void {
    if (!this.session) return;
    const sel = { providerId, modelId, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) };
    this.session.settings.model.current = sel;
    this.session.settings.model.lastUsed = sel;
    this.renderHeaderControls();
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

  scheduleFlush(): void {
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
          this.rendered.set(id, this.snapshotOf(m)); // 增量路径内容已变，快照同步防下次 rebuild 误判重建
          continue; // 增量路径：只改文本节点，零重建
        }
        const node = renderMessage(m as unknown as SessionMessage, this.t, (name, url, isImg) => this.onAttachmentClick(name, url, isImg));
        if (node && existing) {
          node.classList.add('replaced');
          existing.replaceWith(node);
        } else if (node) {
          this.insertMessageNode(node, id);
        } else {
          existing?.remove(); // 整条被过滤（system-reminder 等）
        }
        this.rendered.set(id, this.snapshotOf(m));
      }
      this.dirty.clear();
      if (nearBottom) this.scrollBottom();
      this.renderThinkingState();
      this.hydrateAttachmentThumbs();
      this.refreshTodoPanel();
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

  /**
   * diff 式重建：快照未变的消息节点原位保留（不重播 fade-up、不打断 raw 流式态），
   * 只替换内容有差异的消息；流式中的当前消息即使快照变了也保留增量 raw 态——
   * md 重建后下一个 delta 又转 raw，来回切换是"文字不断闪烁"的另一根因。
   * 权限卡/thinking-cursor/error-toast 无 data-message-id，不在清理范围。
   */
  private rebuildMessages(): void {
    const streaming = this.session?.projection.status === 'running';
    let prev: Element | null = null;
    for (const [id, m] of this.messages) {
      const snap = this.snapshotOf(m);
      let el = this.messagesEl.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
      const skipStreaming = streaming && id === this.currentAssistantId && el !== null;
      if (!skipStreaming && (!el || this.rendered.get(id) !== snap)) {
        const node = renderMessage(m as unknown as SessionMessage, this.t, (name, url, isImg) => this.onAttachmentClick(name, url, isImg));
        if (node && el) {
          node.classList.add('replaced'); // 替换场景抑制入场动画（.msg:last-child 会重播 fade-up）
          el.replaceWith(node);
          el = node;
        } else if (node) {
          this.insertMessageNode(node, id);
          // 顺序校正：期望序 = messages 迭代序，错位时移动（罕见，仅会话重排时发生）
          if (prev && node.previousElementSibling !== prev) prev.insertAdjacentElement('afterend', node);
          el = node;
        } else {
          el?.remove(); // 整条被过滤（system-reminder 等）→ 移除已有节点
          el = null;
        }
      }
      this.rendered.set(id, snap);
      if (el) prev = el; // 被过滤消息不入 DOM，链序保持在上一个可见节点
    }
    for (const el of [...this.messagesEl.children]) {
      const id = (el as HTMLElement).dataset?.['messageId'];
      if (id && !this.messages.has(id)) {
        el.remove();
        this.rendered.delete(id);
      }
    }
    renderPermissionCards(this);
    this.scrollBottom();
    this.renderThinkingState();
    this.refreshTodoPanel();
  }

  markDirtyPermissions(): void {
    renderPermissionCards(this);
  }

  /** 权威上下文窗口：当前模型在 available（配置权威列表）里的值；投影里的 200K 是降级值不可信 */
  authoritativeWindow(): number {
    const cur = this.session?.settings.model.current;
    const fromModel = cur
      ? this.session?.settings.model.available.find((m) => m.ref.providerId === cur.providerId && m.ref.modelId === cur.modelId)?.contextWindow
      : undefined;
    if (fromModel && fromModel > 0) return fromModel;
    return this.session?.projection.contextWindow ?? 0;
  }

  /** 上下文圆环：SVG 进度环，颜色随占用率绿→黄→橙红 */
  renderContextRing(): void {
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

  /** 进程面板：最近一次 TodoWrite 的任务进展常驻展示（推导式，消息集变化时刷新） */
  private refreshTodoPanel(): void {
    renderTodoPanelDom(this.todoPanelEl, extractLatestTodos(this.messages), this.todoClosedCallId, this.t, (callId) => {
      this.todoClosedCallId = callId;
      this.refreshTodoPanel();
    });
  }

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

  renderStatus(): void {
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


  showError(message: string): void {
    const existing = this.messagesEl.querySelector('.error-toast');
    existing?.remove();
    this.messagesEl.append(h('div', { class: 'error-toast' }, `⚠ ${esc(message)}`));
    this.scrollBottom();
    setTimeout(() => this.messagesEl.querySelector('.error-toast')?.remove(), 8000);
  }

  // ═══════════════ 弹层委托（./menus 的唯一入口；slash/@ 弹层在本层直接用 showPopup 设施） ═══════════════

  private get popupEl(): HTMLElement { return this.menus.popupEl; }
  private showPopup(anchor: HTMLElement, content: HTMLElement): void { this.menus.showPopup(anchor, content); }
  private hidePopup(): void { this.menus.hidePopup(); }
  private toggleModelMenu(): void { this.menus.toggleModelMenu(); }
  private toggleSettingsMenu(): void { this.menus.toggleSettingsMenu(); }
  private renderMcpMenu(): void { this.menus.renderMcpMenu(); }
  private toggleModeMenu(): void { this.menus.toggleModeMenu(); }
  private toggleSessionsMenu(): void { this.menus.toggleSessionsMenu(); }
  /** 菜单是否正锚定在该按钮上打开（./events 的圆环刷新也走这里） */
  isOpenFor(anchor: HTMLElement): boolean { return this.menus.isOpenFor(anchor); }
  toggleContextMenu(refresh = false): void { this.menus.toggleContextMenu(refresh); }

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

  // ═══════════════ 输入 ═══════════════

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.previewEl) {
      this.closePreview();
      return;
    }
    if (this.menus.handleComposerKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.onSend();
    }
  }

  onInput(): void {
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

  private showSlashPopup(cmds: { name: string; description: string }[]): void {
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

  scrollBottom(): void {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }
}

