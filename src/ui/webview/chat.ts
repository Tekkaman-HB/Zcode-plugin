/**
 * [INPUT]: 消费协议/bridge 契约、./events、./queue；委托 ./shell、./changes、./composer、./panels、./menus、./todoPanel、./quotaRings 与 ./render
 * [OUTPUT]: ChatApp 共享状态与桥接入口；按会话 id 分发 diff 汇总并在切换时清空旧摘要、流式分块 Markdown/工具复用、消息完成边界校准思考用时、首响等待/空态同步、ready 发送和滚动跟随；MCP 清单保留未连接/未知项
 * [POS]: webview 中枢与各 Host 接口的实现者；布局、输入、模态和菜单分别由子模块负责
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type {
  SessionMessage,
  MessagePart,
  SessionSettings,
  PermissionRequestParams,
  UserInputRequestParams
} from '../../protocol/types';
import type { ToWebviewMessage, FromWebviewMessage, BootstrapPayload, DirEntry, AttachmentRef, QuotaUsagePayload, PairingPanelPayload, McpServerEntry } from '../bridge';
import { h, renderMessage, resetToolCollapseState, isSystemReminderText, updateStreamingText } from './render';
import type { InteractionDraft } from './interaction';
import { makeT, type Locale, type Translate } from './i18n';
import { iconEl } from './icons';
import { createChatShell, renderWelcome, renderContextRing as renderContextRingDom, renderHeaderControls as renderHeaderControlsDom, renderStatus as renderStatusDom, renderResponseWait } from './shell';
import { ComposerController } from './composer';
import { PanelsController } from './panels';
import { renderChangeSummary } from './changes';
import { applySessionEvent, normalizeMessageId, type ChatSessionState, type MutableSessionMessage } from './events';
import { renderPermissionCards } from './queue';
import { MenuController } from './menus';
import { extractLatestTodos, renderTodoPanel as renderTodoPanelDom, loadClosedTodoCallIds, saveClosedTodoCallIds } from './todoPanel';
import { createQuotaRings } from './quotaRings';
export class ChatApp {
  // ═══════════ 子模块宿主面（public：./events ./queue ./menus 经 Host 接口访问） ═══════════
  t: Translate;
  locale: Locale = 'en-US';
  environmentOk = true;
  environmentDetail: string | undefined;
  account: BootstrapPayload['account'] = null;
  serverState: BootstrapPayload['serverState'] = 'stopped';
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
  pasteSeq = 0;
  previewRegistry = new Map<string, string>();
  pastePending = new Map<string, string>();
  previewEl: HTMLElement | null = null;
  /** 手机配对面板：宿主 PairingController 推送的最新载荷（面板重开即显，无需等回包） */
  pairPanel: PairingPanelPayload | null = null;
  pairEl: HTMLElement | null = null;

  ctxBreakdown: { source: string; chars: number }[] | null = null;
  /** 用户关闭的进程面板任务集合（TodoWrite callId，localStorage 持久化——跨会话切换/重载保留；新一轮任务新 callId 自动重现） */
  todoClosedCallIds = loadClosedTodoCallIds();
  /** 消息渲染快照（id → 内容指纹）：rebuild diff 复用节点，未变化的消息不重建——全量重建是消息流闪烁根因 */
  private rendered = new Map<string, string>();

  private snapshotOf(m: MutableSessionMessage): string {
    return `${JSON.stringify(m.info)}\u0000${JSON.stringify(m.parts)}`;
  }

  /** 服务端部件方言归一：partId 缺失补齐、callID→callId（折叠记忆/增量更新/TodoWrite 任务身份依赖）——快照与权威刷新两路共用 */
  private normalizeParts(m: MutableSessionMessage, id: string): void {
    m.parts = (m.parts ?? []).map((pp, i) => ({
      ...pp,
      partId: (pp as { partId?: string }).partId ?? `${id}-p${i}`,
      callId: (pp as { callId?: string }).callId ?? (pp as { callID?: string }).callID
    } as MessagePart));
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
  /** 套餐用量双圆环（5 小时/每周）——数据由宿主 QuotaMonitor 经 quota-usage 消息推送 */
  private readonly quotaRings = createQuotaRings();
  private readonly composer = new ComposerController(this);
  private readonly panels = new PanelsController(this);
  attachBtn!: HTMLButtonElement;
  chatMenuBtn!: HTMLButtonElement;
  jumpBtn!: HTMLButtonElement;
  followOutput = true;
  /** 圆环容器即弹层锚点（MenuHost 面）；最新载荷留存供弹窗渲染 */
  readonly quotaRingBtn: HTMLElement = this.quotaRings.el;
  quotaPayload: QuotaUsagePayload | null = null;
  attachments: AttachmentRef[] = [];
  atDir = '';
  dirEntries: { dir: string; entries: DirEntry[] } | null = null;
  currentAssistantId: string | null = null;
  mcp: { started: number; done: boolean; configuredCount?: number; connectedCount?: number; failedCount?: number; servers?: string[]; crashed?: string[] } | null = null;
  mcpServers: McpServerEntry[] | null = null;
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
    const shell = createChatShell(this.t, {
      sessions: () => this.toggleSessionsMenu(),
      settings: () => this.toggleSettingsMenu(),
      chatMenu: () => this.menus.toggleChatMenu(),
      newChat: () => { this.hidePopup(); this.post({ kind: 'new-session' }); },
      attach: () => this.menus.toggleAttachMenu(),
      model: () => this.toggleModelMenu(),
      mode: () => this.toggleModeMenu(),
      context: () => this.toggleContextMenu(),
      send: () => this.onSend(),
      review: () => this.post({ kind: 'review-changes' }),
      latest: () => { this.followOutput = true; this.scrollBottom(); }
    }, this.quotaRingBtn, this.popupEl);
    Object.assign(this, shell);
    this.root.append(shell.fragment);
    this.composer.bind();
    this.quotaRingBtn.addEventListener('click', () => this.toggleQuotaMenu());
    this.messagesEl.addEventListener('scroll', () => {
      this.followOutput = this.isNearBottom();
      this.jumpBtn.classList.toggle('hidden', this.followOutput);
    });
    const scriptSrc = document.querySelector('script')?.getAttribute('src') ?? '';
    this.titleEl.title = `ZCode webview v${scriptSrc.match(/zcode-vscode-([0-9.]+)\//)?.[1] ?? 'dev'}`;
    this.renderOverlay();
  }

  // ═══════════════ 桥接消息入口 ═══════════════

  onMessage(msg: ToWebviewMessage): void {
    if (msg.kind === 'session-snapshot' || msg.kind === 'session-closed') renderChangeSummary(this.root, { sessionId: '', status: 'ready', files: 0, added: 0, deleted: 0, binary: 0 }, this.t);
    switch (msg.kind) {
      case 'session-changes': if (msg.data.sessionId === this.session?.info.sessionId) renderChangeSummary(this.root, msg.data, this.t); break;
      case 'bootstrap':
        this.locale = msg.data.locale;
        this.defaultMode = msg.data.defaultMode;
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
        this.hidePopup();
        this.followOutput = true;
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
          this.normalizeParts(m as MutableSessionMessage, id);
          this.messages.set(id, m as MutableSessionMessage);
        }
        this.pendingPermissions.clear();
        this.pendingUserInputs.clear();
        this.ixDrafts.clear();
        this.ixHeadId = null;
        this.mcp = null;
        this.rendered.clear();
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
        this.hidePopup();
        this.followOutput = true;
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
        this.queuedCount = 0;
        this.queuedItems = [];
        this.renderQueued();
        this.rebuildMessages();
        this.renderHeaderControls();
        this.renderOverlay();
        break;
      case 'session-event': {
        // 回合 status 走 session.updated 投影通道（state.updated 不带）——status/后台任务真正变化时
        // 同步发送按钮供能与圆环（流式 delta 高频，不能无条件刷）；state-updated 路径由 renderStatus 覆盖
        const prevStatus = this.session?.projection.status;
        const prevJobs = this.session?.projection.backgroundJobs?.length ?? 0;
        applySessionEvent(this, msg.data);
        if (this.session && (this.session.projection.status !== prevStatus
          || (this.session.projection.backgroundJobs?.length ?? 0) !== prevJobs)) {
          this.renderStatus();
        }
        break;
      }
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
      case 'interactions-dropped':
        // 宿主已对未答交互自动撤回（stop/插队/会话生命周期）——卡若还挂着就是"可作答"假象，
        // 立即清空并提示（session-closed/snapshot 路径已自带清理，这里兜 stop/dispose 的漏网）
        this.pendingPermissions.clear();
        this.pendingUserInputs.clear();
        this.interactionOrder = [];
        this.ixDrafts.clear();
        this.ixHeadId = null;
        this.markDirtyPermissions();
        this.showError(this.t('ixDropped'));
        break;
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
        if (this.isOpenFor(this.gearBtn)) this.renderMcpMenu();
        break;
      }
      case 'messages': {
        // 权威消息列表校准（回合结束后/工具完成时拉取）
        this.messages.clear();
        for (const m of msg.data.messages ?? []) {
          const id = normalizeMessageId(m as MutableSessionMessage) || `m-${this.messages.size}`;
          this.normalizeParts(m as MutableSessionMessage, id);
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
      case 'quota-usage':
        this.quotaPayload = msg.data;
        this.quotaRings.update(msg.data, this.t, this.locale);
        // 弹窗开着时数据到达 → 原地刷新（对标 ctx 弹层的 isOpenFor 补刷）
        if (this.isOpenFor(this.quotaRingBtn)) this.toggleQuotaMenu(true);
        break;
      case 'pair-status': {
        const prev = this.pairPanel;
        const next = msg.data;
        this.pairPanel = next;
        // diff 门：内容未变不重渲染（backdrop 整卡重建会重播动画=闪烁根源）
        if (
          this.pairEl &&
          (prev?.status !== next.status || prev?.qrUrl !== next.qrUrl || prev?.message !== next.message ||
            prev?.identity !== next.identity || (prev?.qrSvg ?? '') !== (next.qrSvg ?? ''))
        ) {
          this.renderPairPanel();
        }
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
        const node = renderMessage(m as unknown as SessionMessage, this.t, (name, url, isImg) => this.onAttachmentClick(name, url, isImg), { live: streaming && id === this.currentAssistantId });
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
      this.renderOverlay();
      renderResponseWait(this);
      if (nearBottom) this.scrollBottom();
      this.hydrateAttachmentThumbs();
      this.refreshTodoPanel();
    });
  }

  /**
   * 流式增量更新：正文分块保留已完成 DOM，推理 textContent 直写，工具按内容指纹判断变化。
   * 返回 false 表示结构已变（新部件/工具状态变化），需要整消息重建。
   * 回合结束后的 refresh-messages 进行完整 Markdown 校准。
   */
  private updateMessageIncrementally(node: HTMLElement, m: MutableSessionMessage): boolean {
    if ((m.info.time as { completed?: number } | undefined)?.completed !== undefined) return false; // 完成边界到达后按落档重建。
    for (const p of m.parts) {
      const pid = (p as { partId?: string }).partId;
      if (!pid) continue;
      const target = node.querySelector(`[data-part-id="${CSS.escape(pid)}"]`);
      if (!target) return false; // 新部件（tool/新文本块）→ 重建
      if (p.type === 'text') {
        const tp = p as unknown as { text?: string };
        updateStreamingText(target as HTMLElement, tp.text ?? '', this.t, () => this.scrollBottom());
      } else if (p.type === 'reasoning') {
        const body = target.querySelector('.reasoning-body') as HTMLElement | null;
        if (body) {
          body.textContent = (p as unknown as { text?: string }).text ?? '';
          body.classList.add('streaming');
        }
      } else if (p.type === 'tool' && target.getAttribute('data-tool-state') !== JSON.stringify(p)) {
        return false; // 只在工具内容变化时重建，既有工具不应阻断后续正文增量
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
   * diff 式重建：快照未变的消息节点原位保留，不重播 fade-up、不打断流式分块状态；
   * 流式中的当前消息即使快照变了也保留增量 DOM，回合结束再完整校准。
   * 工具事件拉取全量消息时，避免反复替换正在阅读的正文。
   * 权限卡/error-toast 无 data-message-id，不在清理范围。
   */
  private rebuildMessages(): void {
    const streaming = this.session?.projection.status === 'running';
    let prev: Element | null = null;
    for (const [id, m] of this.messages) {
      const snap = this.snapshotOf(m);
      let el = this.messagesEl.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
      // 中断回合遗留的空壳助手消息（resume/中止后 parts 永远为空，渲染成永不停止的"思考中"）：
      // 非当前流式消息一律不渲染——正在流式的空消息（id===currentAssistantId）保留占位
      if ((m.info?.role ?? '') === 'assistant' && !m.parts.length && id !== this.currentAssistantId) {
        el?.remove();
        this.rendered.set(id, snap);
        continue;
      }
      const skipStreaming = streaming && id === this.currentAssistantId && el !== null && (m.info.time as { completed?: number } | undefined)?.completed === undefined;
      if (!skipStreaming && (!el || this.rendered.get(id) !== snap)) {
        const node = renderMessage(m as unknown as SessionMessage, this.t, (name, url, isImg) => this.onAttachmentClick(name, url, isImg), { live: streaming && id === this.currentAssistantId });
        if (node && el) {
          node.classList.add('replaced'); // 替换场景抑制入场动画（.msg:last-child 会重播 fade-up）
          el.replaceWith(node);
          el = node;
        } else if (node) {
          this.insertMessageNode(node, id);
          el = node;
        } else {
          el?.remove(); // 整条被过滤（system-reminder 等）→ 移除已有节点
          el = null;
        }
      }
      this.rendered.set(id, snap);
      if (el) {
        // 顺序校正（新旧节点统一）：期望序 = messages 迭代序。错位来源：
        // 权威回显换 id 重渲染、会话重排残留——这里一律归位；首条消息不在流顶时前置
        if (prev) {
          if (el.previousElementSibling !== prev) prev.insertAdjacentElement('afterend', el);
        } else if (el !== this.messagesEl.firstElementChild) {
          this.messagesEl.prepend(el);
        }
        prev = el; // 被过滤消息不入 DOM，链序保持在上一个可见节点
      }
    }
    for (const el of [...this.messagesEl.children]) {
      const id = (el as HTMLElement).dataset?.['messageId'];
      if (id && !this.messages.has(id)) {
        el.remove();
        this.rendered.delete(id);
      }
    }
    this.renderOverlay();
    renderPermissionCards(this);
    renderResponseWait(this);
    this.scrollBottom();
    this.refreshTodoPanel();
  }

  markDirtyPermissions(): void {
    renderPermissionCards(this);
    renderResponseWait(this);
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
  renderContextRing(): void { renderContextRingDom(this); }

  /** 进程面板：最近一次 TodoWrite 的任务进展常驻展示（推导式，消息集变化时刷新） */
  private refreshTodoPanel(): void {
    renderTodoPanelDom(this.todoPanelEl, extractLatestTodos(this.messages), this.todoClosedCallIds, this.t, (callId) => {
      this.todoClosedCallIds.add(callId);
      saveClosedTodoCallIds(this.todoClosedCallIds);
      this.refreshTodoPanel();
    });
  }

  /** 运行态判定：回合运行/等待权限/后台任务任一为真 */
  isBusyLike(): boolean {
    const st = this.session?.projection.status;
    return st === 'running' || st === 'waiting' || (this.session?.projection.backgroundJobs?.length ?? 0) > 0;
  }

  // ═══════════════ 头部 / 状态 / 浮层 ═══════════════

  private renderHeaderControls(): void { renderHeaderControlsDom(this); }

  private renderBanner(): void {
    // 启动过程零横幅；失败走自动消失的错误气泡（重试入口在齿轮菜单）；
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
    const loginRequired = Boolean(this.account && !this.account.loggedIn);
    const visible = this.environmentOk && (loginRequired || this.messages.size === 0);
    this.overlayEl.classList.toggle('visible', visible);
    this.messagesEl.style.display = visible ? 'none' : '';
    this.composerInput.placeholder = this.t(this.messages.size ? 'followupPlaceholder' : 'inputPlaceholder');
    this.composerInput.setAttribute('aria-label', this.composerInput.placeholder);
    this.jumpBtn.classList.toggle('hidden', visible || this.followOutput);
    if (visible) renderWelcome(this.overlayEl, this.t, {
      loginRequired, starting: this.serverState === 'starting',
      login: () => this.post({ kind: 'login' }),
      suggest: text => { this.composerInput.value = text; this.composerInput.focus(); this.onInput(); }
    });
    else this.overlayEl.replaceChildren();
  }

  renderStatus(): void { renderStatusDom(this); }

  /**
   * 发送按钮供能规则：
   * 输入框有内容（文字/附件）→ 发送态（点击=入队发送）
   * 输入框为空且回合运行中 → 停止态（点击=中止）
   * 其余 → 发送态
   */
  updateSendAffordance(): void {
    const running = this.isBusyLike();
    const hasContent = this.composerInput.value.trim().length > 0 || this.attachments.length > 0;
    const stopArmed = running && !hasContent;
    const label = this.t(stopArmed ? 'stop' : 'send');
    this.sendBtn.replaceChildren(iconEl(stopArmed ? 'stop' : 'arrowUp'));
    this.sendBtn.title = label;
    this.sendBtn.setAttribute('aria-label', label);
    this.sendBtn.classList.toggle('stop', stopArmed);
    this.sendBtn.disabled = !this.environmentOk || !this.account?.loggedIn || this.serverState !== 'ready'
      || !this.session || this.pastePending.size > 0 || (!running && !hasContent);
  }

  showError(message: string): void {
    const existing = this.messagesEl.querySelector('.error-toast');
    existing?.remove();
    this.messagesEl.append(h('div', { class: 'error-toast' }, message));
    this.scrollBottom();
    setTimeout(() => this.messagesEl.querySelector('.error-toast')?.remove(), 8000);
  }

  // ═══════════════ 弹层委托（./menus 的唯一入口；slash/@ 弹层在本层直接用 showPopup 设施） ═══════════════

  get popupEl(): HTMLElement { return this.menus.popupEl; }
  showPopup(anchor: HTMLElement, content: HTMLElement): void { this.menus.showPopup(anchor, content); }
  hidePopup(): void { this.menus.hidePopup(); }
  private toggleModelMenu(): void { this.menus.toggleModelMenu(); }
  private toggleSettingsMenu(): void { this.menus.toggleSettingsMenu(); }
  private renderMcpMenu(): void { this.menus.renderMcpMenu(); }
  private toggleModeMenu(): void { this.menus.toggleModeMenu(); }
  private toggleSessionsMenu(): void { this.menus.toggleSessionsMenu(); }
  handleComposerKeydown(e: KeyboardEvent): boolean { return this.menus.handleComposerKeydown(e); }
  conversationText(): string {
    return [...this.messages.values()]
      .filter(m => m.info.visibility !== 'model-only')
      .map(m => m.parts.filter(p => p.type === 'text' && !(p as { ignored?: boolean }).ignored && !isSystemReminderText(String((p as { text?: string }).text ?? '')))
        .map(p => String((p as { text?: string }).text ?? '')).join('\n'))
      .filter(Boolean).join('\n\n');
  }
  /** 菜单是否正锚定在该按钮上打开（./events 的圆环刷新也走这里） */
  isOpenFor(anchor: HTMLElement): boolean { return this.menus.isOpenFor(anchor); }
  toggleContextMenu(refresh = false): void { this.menus.toggleContextMenu(refresh); }
  toggleQuotaMenu(refresh = false): void { this.menus.toggleQuotaMenu(refresh); }

  // ═══════════════ 附件与 @ 引用 ═══════════════

  private renderQueued(): void { this.composer.renderQueued(); }

  private renderAttachRow(): void { this.composer.renderAttachRow(); }

  /** @ 引用：输入框插入 @ 并弹出工作区文件过滤列表 */
  onAtReference(): void { this.composer.onAtReference(); }

  /** @ 引用弹层：目录浏览器——文件夹下钻、文件插入引用 */
  private renderAtPopup(): void { this.composer.renderAtPopup(); }

  onInput(): void { this.composer.onInput(); }

  private onSend(): void { this.composer.onSend(); }

  /** 附件芯片点击：统一走 lightbox（图片放大预览；无数据时提示） */
  private onAttachmentClick(name: string, url?: string, _isImg?: boolean): void {
    this.panels.openPreview(name, url);
  }

  /** 回填消息内图片附件的缩略图 src（registry 命中时）——每次渲染后调用 */
  private hydrateAttachmentThumbs(): void { this.composer.hydrateAttachmentThumbs(); }

  closePreview(): void { this.panels.closePreview(); }

  /** 打开配对面板并请求宿主回推当前状态（常驻连接下通常已有缓存即时可显） */
  openPairPanel(): void { this.panels.openPairPanel(); }

  private renderPairPanel(): void { this.panels.renderPairPanel(); }

  private isNearBottom(): boolean {
    const el = this.messagesEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  scrollBottom(): void {
    requestAnimationFrame(() => {
      if (!this.followOutput) return;
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this.jumpBtn.classList.add('hidden');
    });
  }
}

