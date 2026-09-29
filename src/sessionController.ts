/**
 * [INPUT]: 依赖 ./serverManager 的 ZcodeServer、./protocol/types、./ui/bridge 的消息契约
 * [OUTPUT]: 对外提供 SessionController（会话生命周期 + 事件流转发 + 反向请求转 UI）
 * [POS]: 会话控制层——extension.ts 与 UI Provider 之间的业务中枢
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type {
  SessionCreateResult,
  SessionListResult,
  SessionSubscribeResult,
  SessionMessage,
  McpTelemetryEvent,
  PermissionRequestParams,
  UserInputRequestParams,
  UserInputResponse,
  SessionMode,
  ModelSelection
} from './protocol/types';
import { asSessionEvent, asStateUpdated } from './protocol/types';
import { ZcodeServer } from './serverManager';
import type { ToWebviewMessage, SessionSnapshotPayload } from './ui/bridge';

export interface SessionControllerCallbacks {
  toWebview: (msg: ToWebviewMessage) => void;
}

export class SessionController {
  private server: ZcodeServer;
  private cbs: SessionControllerCallbacks;
  /** 反向请求应答器（值 = 数组）：CLI 对未答请求每 1s reannounce（uRn.reannounceIntervalMs=1000），
   *  每次重发都是独立 JSON-RPC 实例——set 覆盖会孤儿化早到实例的 Promise，必须扇出应答 */
  private permissionResponders = new Map<string, ((result: unknown) => void)[]>();
  private userInputResponders = new Map<string, ((result: UserInputResponse) => void)[]>();
  /** 未答交互的最新载荷（reannounce 到达即刷新）：webview 重载（reload/内存回收）时重投，
   *  CLI 的 reannounce 只覆盖请求存活期，重载窗口外到达的会永久丢卡 */
  private pendingPermissionReqs = new Map<string, PermissionRequestParams>();
  private pendingUserInputReqs = new Map<string, UserInputRequestParams>();
  private currentSessionId: string | null = null;
  private mcpStarted = 0;
  private mcpServerIds: string[] = [];
  private mcpCrashed: string[] = [];
  private lastActivityAt = Date.now();
  /** 运行中收到的补充输入：回合结束自动依次出队（对标桌面端 queue auto-drain） */
  private pendingQueue: { id: string; content: string; attachments?: { name: string; path?: string; mime?: string; size?: number; dataUrl?: string }[] }[] = [];
  private queueSeq = 0;
  /** 看门狗：busy 卡死兜底（事件丢失/回合悬挂时强制解锁） */
  private busy = false;
  private busySince = 0;
  private watchdog: NodeJS.Timeout | undefined;
  /** 出队推送（含全文），供 UI 渲染队列条目 */
  private pushQueue(): void {
    this.cbs.toWebview({
      kind: 'queued-update',
      data: {
        queued: this.pendingQueue.length,
        items: this.pendingQueue.map((q) => ({ id: q.id, content: q.content }))
      }
    });
  }

  constructor(server: ZcodeServer, cbs: SessionControllerCallbacks) {
    this.server = server;
    this.cbs = cbs;
    // 看门狗：busy 超 120s 且期间无任何会话事件 → 判定卡死，强制解锁并归位 UI
    this.watchdog = setInterval(() => {
      if (!this.busy) return;
      const idleFor = Date.now() - Math.max(this.busySince, this.lastActivityAt);
      if (idleFor > 120_000) {
        this.busy = false;
        this.busySince = 0;
        if (this.currentSessionId) {
          this.cbs.toWebview({
            kind: 'state-updated',
            data: { patch: { status: 'idle' }, revision: 0, reason: 'watchdog-recovered' }
          });
        }
        this.scheduleQueueDrain();
      }
    }, 15_000);
    this.watchdog.unref?.();
  }

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  /** 服务端通知解包：session/event + state.updated + MCP 遥测 转发 UI */
  handleNotification(method: string, params: unknown): void {
    if (method === 'session/event') {
      const ev = asSessionEvent(params);
      if (ev) {
        this.lastActivityAt = Date.now();
        if (this.currentSessionId && ev.sessionId && ev.sessionId !== this.currentSessionId) return;
        if (ev.type === 'turn.completed' || ev.type === 'turn.failed') {
          this.busy = false;
          this.scheduleQueueDrain();
        }
        this.cbs.toWebview({ kind: 'session-event', data: ev });
      }
      return;
    }
    if (method === 'process/mcpTelemetry') {
      const m = params as McpTelemetryEvent | undefined;
      if (!m) return;
      if (m.kind === 'process_start') {
        this.mcpStarted++;
        const id = typeof m.mcpId === 'string' && m.mcpId ? m.mcpId : `#${this.mcpStarted}`;
        if (!this.mcpServerIds.includes(id)) this.mcpServerIds.push(id);
        this.cbs.toWebview({ kind: 'mcp-progress', data: { started: this.mcpStarted, done: false, servers: this.mcpServerIds.slice() } });
      } else if (m.kind === 'process_crash') {
        const id = typeof m.mcpId === 'string' ? m.mcpId : '';
        if (id && !this.mcpCrashed.includes(id)) this.mcpCrashed.push(id);
        this.cbs.toWebview({ kind: 'mcp-progress', data: { started: this.mcpStarted, done: false, servers: this.mcpServerIds.slice(), crashed: this.mcpCrashed.slice() } });
      } else if (m.kind === 'session_startup') {
        this.cbs.toWebview({
          kind: 'mcp-progress',
          data: {
            started: this.mcpStarted,
            done: true,
            configuredCount: m.configuredCount,
            connectedCount: m.connectedCount,
            failedCount: m.failedCount,
            servers: this.mcpServerIds.slice(),
            crashed: this.mcpCrashed.slice()
          }
        });
        this.mcpStarted = 0;
        this.mcpServerIds = [];
        this.mcpCrashed = [];
      }
      return;
    }
    if (method === 'state.updated') {
      const st = asStateUpdated(params);
      if (st) {
        if (st.sessionId && this.currentSessionId && st.sessionId !== this.currentSessionId) return;
        const patch = st.patch ?? {};
        this.cbs.toWebview({ kind: 'state-updated', data: { patch, revision: st.revision, reason: st.reason } });
      }
    }
    // 其余通知（process/*、startup/* 等）UI 不关心
  }

  handlePermissionRequest(req: PermissionRequestParams, respond: (result: unknown) => void): void {
    const list = this.permissionResponders.get(req.requestId) ?? [];
    list.push(respond);
    this.permissionResponders.set(req.requestId, list);
    this.pendingPermissionReqs.set(req.requestId, req);
    this.cbs.toWebview({ kind: 'permission-request', data: req });
  }

  respondPermission(requestId: string, result: unknown): void {
    const list = this.permissionResponders.get(requestId);
    this.permissionResponders.delete(requestId);
    this.pendingPermissionReqs.delete(requestId);
    for (const fn of list ?? []) fn(result);
  }

  handleUserInputRequest(req: UserInputRequestParams, respond: (result: UserInputResponse) => void): void {
    const list = this.userInputResponders.get(req.requestId) ?? [];
    list.push(respond);
    this.userInputResponders.set(req.requestId, list);
    this.pendingUserInputReqs.set(req.requestId, req);
    this.cbs.toWebview({ kind: 'user-input-request', data: req });
  }

  respondUserInput(requestId: string, response: UserInputResponse): void {
    const list = this.userInputResponders.get(requestId);
    this.userInputResponders.delete(requestId);
    this.pendingUserInputReqs.delete(requestId);
    for (const fn of list ?? []) fn(response);
  }

  /** webview 重载后重投未答交互卡（reannounce 兜不住跨重载的投递） */
  redeliverPendingInteractions(): void {
    for (const req of this.pendingPermissionReqs.values()) {
      this.cbs.toWebview({ kind: 'permission-request', data: req });
    }
    for (const req of this.pendingUserInputReqs.values()) {
      this.cbs.toWebview({ kind: 'user-input-request', data: req });
    }
  }

  dropPendingInteractions(): void {
    for (const list of this.permissionResponders.values()) {
      for (const fn of list) fn({ decision: 'deny', reason: 'session closed' });
    }
    this.permissionResponders.clear();
    this.pendingPermissionReqs.clear();
    for (const list of this.userInputResponders.values()) {
      for (const fn of list) fn({ action: 'decline', reason: 'session closed' });
    }
    this.userInputResponders.clear();
    this.pendingUserInputReqs.clear();
  }

  // ═══════════════ 会话操作 ═══════════════

  /** create/resume 响应 → webview 快照载荷（SessionCreateResult 是其超集，显式取字段免双重转换） */
  private snapshotPayload(result: SessionCreateResult): SessionSnapshotPayload {
    return {
      session: result.session,
      settings: result.settings,
      projection: result.projection,
      messages: result.messages,
      slashCommands: result.slashCommands ?? []
    };
  }

  async newSession(workspacePath: string, mode: SessionMode, model?: ModelSelection): Promise<SessionCreateResult> {
    // persistence:'deferred' = 草稿会话：不落库不进历史，session/send 时自动升级为 immediate
    const result = await this.server.request<SessionCreateResult>('session/create', {
      workspace: { workspacePath, workspaceKey: workspacePath },
      mode,
      persistence: 'deferred',
      ...(model ? { model } : {})
    });
    this.currentSessionId = result.session.sessionId;
    this.dropPendingInteractions();
    this.mcpStarted = 0;
    this.mcpServerIds = [];
    this.mcpCrashed = [];
    // 新会话 = 全新生命周期：复位运行态与队列（服务重启后 busy 卡死的根治）
    this.busy = false;
    this.busySince = 0;
    this.pendingQueue = [];
    this.cbs.toWebview({ kind: 'session-snapshot', data: this.snapshotPayload(result) });
    await this.subscribe(result.session.sessionId);
    return result;
  }

  /** MCP 在跑进程清单（名称真相源：mcp/list 只报 workspace 池不可用） */
  async fetchMcpServers(): Promise<{ name: string; pid: number; source: string }[]> {
    const result = await this.server.request<{ processes?: { pid: number; serverName: string; mcpSource: string; pluginName?: string }[] }>('process/childProcesses', {}, 15_000);
    return (result.processes ?? []).map((pr) => ({
      name: pr.pluginName ?? pr.serverName,
      pid: pr.pid,
      source: pr.mcpSource
    }));
  }

  /** 订阅活流（desktop-continuous），并将 backlog 事件回放进 UI 流 */
  private async subscribe(sessionId: string): Promise<void> {
    try {
      const sub = await this.server.request<SessionSubscribeResult>('session/subscribe', {
        sessionId,
        deliveryKind: 'desktop-continuous'
      }, 15_000);
      for (const ev of sub.events ?? []) {
        this.cbs.toWebview({ kind: 'session-event', data: ev });
      }
    } catch {
      /* 订阅失败不阻塞会话；state.updated 投影仍可用 */
    }
  }

  async resumeSession(sessionId: string): Promise<void> {
    const result = await this.server.request<SessionCreateResult>('session/resume', {
      sessionId,
      workspace: undefined
    });
    this.currentSessionId = sessionId;
    this.dropPendingInteractions();
    this.mcpStarted = 0;
    this.mcpServerIds = [];
    this.mcpCrashed = [];
    this.cbs.toWebview({ kind: 'session-snapshot', data: this.snapshotPayload(result) });
    await this.subscribe(sessionId);
    // resume 快照的 projection 不含用量：拉权威消息（step-finish tokens）校准圆环
    await this.refreshMessages();
  }

  async send(content: string, attachments?: { name: string; path?: string; mime?: string; size?: number; dataUrl?: string }[]): Promise<void> {
    if (!this.currentSessionId) throw new Error('没有活动会话');
    // app-server 在回合运行中拒绝 session/send（-32010）：宿主侧排队，回合结束自动出队
    if (this.isBusy()) {
      this.pendingQueue.push({ id: `q${++this.queueSeq}`, content, attachments });
      this.pushQueue();
      return;
    }
    await this.sendNow(content, attachments);
  }

  private isBusy(): boolean {
    return this.busy;
  }

  private async sendNow(content: string, attachments?: { name: string; path?: string; mime?: string; size?: number; dataUrl?: string }[]): Promise<void> {
    this.busy = true;
    this.busySince = Date.now();
    try {
      await this.server.request('session/send', {
        sessionId: this.currentSessionId,
        content,
        // 附件 wire 契约（probe-attach 实证 zcodePromptAttachmentSchema）：
        // {kind:'image'|'video'|'pdf'|'file', filename, mimeType, localPath}——dataBase64 不送达，图片必须落盘走 localPath
        ...(attachments && attachments.length
          ? {
              attachments: attachments
                .filter((a) => a.path)
                .map((a) => ({
                  kind: a.mime?.startsWith('image/')
                    ? 'image'
                    : a.mime === 'application/pdf' ? 'pdf' : a.mime?.startsWith('video/') ? 'video' : 'file',
                  filename: a.name,
                  mimeType: a.mime ?? 'application/octet-stream',
                  localPath: a.path
                }))
            }
          : {})
      });
      // 乐观渲染：受理即显示用户消息，不等服务端 message.upserted 回显（排队/插队回显延迟数秒）
      this.cbs.toWebview({
        kind: 'optimistic-user',
        data: { id: `local-${Date.now()}`, text: content, attachments: attachments?.map((a) => ({ name: a.name })) }
      });
    } catch (e) {
      // -32010（回合运行中）：busy 标志与服务器实际状态失步（事件错过）时的自愈——转排队而非报错
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('-32010') || /already running/i.test(msg)) {
        this.busy = true;
        if (!this.busySince) this.busySince = Date.now();
        this.pendingQueue.push({ id: `q${++this.queueSeq}`, content, attachments });
        this.pushQueue();
        return;
      }
      this.busy = false;
      throw e;
    }
  }

  /** 回合结束后合并出队（800ms 去抖，等投影落定） */
  private queueDrainTimer: NodeJS.Timeout | undefined;
  private scheduleQueueDrain(): void {
    if (this.queueDrainTimer) clearTimeout(this.queueDrainTimer);
    this.queueDrainTimer = setTimeout(() => {
      this.queueDrainTimer = undefined;
      void this.drainQueue();
    }, 800);
    this.queueDrainTimer.unref?.();
  }

  private async drainQueue(): Promise<void> {
    if (this.busy || !this.pendingQueue.length || !this.currentSessionId) return;
    const next = this.pendingQueue.shift()!;
    this.pushQueue();
    try {
      await this.sendNow(next.content, next.attachments);
      if (this.pendingQueue.length) this.scheduleQueueDrain();
    } catch {
      // 发送失败（回合实际未空闲等）：塞回队首等下一次 drain
      this.pendingQueue.unshift(next);
      this.scheduleQueueDrain();
    }
  }

  /** 删除某条排队 */
  removeQueueItem(id: string): void {
    this.pendingQueue = this.pendingQueue.filter((q) => q.id !== id);
    this.pushQueue();
  }

  /**
   * 立即发送（插队）：中止当前回合 → 把目标条提到队首（其余保留）→ 等中止落定后发出。
   * turn.failed/completed 事件会触发 drainQueue（800ms 去抖），此处只负责 stop + 重排。
   */
  async prioritizeQueueItem(id: string): Promise<void> {
    const idx = this.pendingQueue.findIndex((q) => q.id === id);
    if (idx < 0) return;
    const [item] = this.pendingQueue.splice(idx, 1);
    this.pendingQueue.unshift(item);
    this.pushQueue();
    // 打断当前回合；turn.failed 事件 → busy=false → scheduleQueueDrain 自动发出队首（即该条）
    if (this.isBusy()) {
      await this.stop();
    } else {
      this.scheduleQueueDrain();
    }
  }


  async stop(): Promise<void> {
    if (!this.currentSessionId) return;
    this.dropPendingInteractions();
    await this.server.request('session/stop', { sessionId: this.currentSessionId }).catch(() => {
      /* 会话可能已空闲 */
    });
  }

  async setModel(providerId: string, modelId: string, reasoningLevel?: string): Promise<void> {
    if (!this.currentSessionId) return;
    await this.server.request('session/setModel', {
      sessionId: this.currentSessionId,
      model: { providerId, modelId, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) }
    });
  }

  async setMode(mode: SessionMode): Promise<void> {
    if (!this.currentSessionId) return;
    await this.server.request('session/setMode', {
      sessionId: this.currentSessionId,
      mode
    });
  }

  /** 回合结束后拉取权威消息列表，校准流式渲染 */
  async refreshMessages(): Promise<void> {
    if (!this.currentSessionId) return;
    try {
      const result = await this.server.request<{ messages: SessionMessage[] }>('session/messages', {
        sessionId: this.currentSessionId
      }, 15_000);
      this.cbs.toWebview({ kind: 'messages', data: { messages: result.messages ?? [] } });
    } catch {
      /* 拉取失败保持现状 */
    }
  }

  async listSessions(workspacePath?: string): Promise<SessionListResult> {
    return this.server.request<SessionListResult>('session/list', {
      ...(workspacePath ? { workspace: { workspacePath, workspaceKey: workspacePath } } : {})
    });
  }

  closeSessionUI(): void {
    this.currentSessionId = null;
    this.pendingQueue = [];
    this.dropPendingInteractions();
    this.cbs.toWebview({ kind: 'session-closed' });
  }

  dispose(): void {
    this.dropPendingInteractions();
    this.server.dispose();
  }
}
