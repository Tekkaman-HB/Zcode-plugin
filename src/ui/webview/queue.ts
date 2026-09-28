/**
 * [INPUT]: 消费 ../bridge 的 FromWebviewMessage、./interaction 的卡片渲染器与草稿、../../protocol/types、./i18n 的 Translate
 * [OUTPUT]: 对外提供 QueueHost 接口、renderPermissionCards()（交互焦点队列渲染）与 submitUserInput()（用户输入应答 + 队列推进）
 * [POS]: webview 的交互焦点队列——权限卡与用户输入卡统一排队、tab 可点切换、一次只渲染选中一张；chat.ts 委托至此
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { PermissionRequestParams, PermissionResponse, UserInputRequestParams, UserInputResponse } from '../../protocol/types';
import type { FromWebviewMessage } from '../bridge';
import { h } from './render';
import { renderPermissionCard, renderUserInputCard, createInteractionDraft, type InteractionDraft } from './interaction';
import type { Translate } from './i18n';

/** 交互焦点队列对宿主（ChatApp）的最小访问面 */
export interface QueueHost {
  t: Translate;
  messagesEl: HTMLElement;
  pendingPermissions: Map<string, PermissionRequestParams>;
  pendingUserInputs: Map<string, UserInputRequestParams>;
  /** 交互卡草稿（键 = requestId，两通道共用——CLI 会在两通道复用同一 requestId）：重渲染不丢已答内容与向导进度 */
  ixDrafts: Map<string, InteractionDraft>;
  /** 当前拥有焦点的交互卡（type:id）——只在队首切换时抢焦点，重渲染不偷 */
  ixHeadId: string | null;
  /** 交互焦点队列：权限卡与用户输入卡统一排队，tab 可点切换，一次亮一张 */
  interactionOrder: { type: 'permission' | 'input'; id: string }[];
  /** 当前展示的队列位次（tab 点击切换；提交后原地指向下一条） */
  ixSelected: number;
  post(msg: FromWebviewMessage): void;
  scrollBottom(): void;
}

/**
 * 交互焦点卡：权限与用户输入统一排队。tab 可点切换查看/作答，提交后原地推进下一条。
 * tab 标签可区分请求（权限 = 工具名 · 理由摘要；输入 = 首 header），不再千篇一律。
 */
export function renderPermissionCards(host: QueueHost): void {
  host.messagesEl.querySelectorAll('.permission-card, .user-input-card').forEach((n) => n.remove());

  // 同步队列与登记表（resolved 的条目移出）+ 兜底去重
  host.interactionOrder = host.interactionOrder.filter((e) => {
    if (e.type === 'permission') return host.pendingPermissions.has(e.id);
    return host.pendingUserInputs.has(e.id);
  });
  if (host.interactionOrder.length > 1) {
    const seen = new Set<string>();
    host.interactionOrder = host.interactionOrder.filter((e) => {
      const k = `${e.type}:${e.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  if (!host.interactionOrder.length) {
    host.ixSelected = 0;
    host.ixHeadId = null;
    host.scrollBottom();
    return;
  }
  host.ixSelected = Math.max(0, Math.min(host.ixSelected, host.interactionOrder.length - 1));

  const focus = host.interactionOrder[host.ixSelected];
  const total = host.interactionOrder.length;

  // tab 标签：输入卡取首 header；权限卡 = 工具名 · 理由摘要（reason 是权限请求唯一区分字段）
  const tabLabel = (e: { type: 'permission' | 'input'; id: string }): string => {
    const req = e.type === 'permission' ? host.pendingPermissions.get(e.id) : host.pendingUserInputs.get(e.id);
    if (!req) return '…';
    const qs = ((req.input ?? {}) as { questions?: { header: string }[] }).questions
      ?? ((req as unknown as { questions?: { header: string }[] }).questions ?? []);
    if (qs.length) return qs[0].header + (qs.length > 1 ? ` +${qs.length - 1}` : '');
    if (e.type === 'permission') {
      const p = req as PermissionRequestParams;
      const reason = (p.reason || '').replace(/\s+/g, ' ').trim();
      const text = p.toolName && reason ? `${p.toolName} · ${reason}` : (p.toolName || host.t('permissionNeeded'));
      return text.length > 30 ? text.slice(0, 29) + '…' : text;
    }
    const prompt = (req as { prompt?: string }).prompt;
    if (prompt) return prompt.length > 16 ? prompt.slice(0, 16) + '…' : prompt;
    return host.t('respond');
  };
  const tabs = h('div', { class: 'ix-tabs' });
  host.interactionOrder.forEach((e, i) => {
    tabs.append(h('button', {
      type: 'button',
      class: `ix-tab ${i === host.ixSelected ? 'active' : ''}`,
      title: tabLabel(e),
      onclick: () => {
        if (host.ixSelected !== i) {
          host.ixSelected = i;
          renderPermissionCards(host);
        }
      }
    }, `${i + 1}. ${tabLabel(e)}`));
  });
  if (total > 1) tabs.append(h('span', { class: 'ix-hint' }, `${host.ixSelected + 1}/${total}`));

  if (focus.type === 'permission') {
    const req = host.pendingPermissions.get(focus.id)!;
    let draft = host.ixDrafts.get(req.requestId);
    if (!draft) { draft = createInteractionDraft(); host.ixDrafts.set(req.requestId, draft); }
    const card = renderPermissionCard(req, host.t, draft, (response) => {
      host.pendingPermissions.delete(req.requestId);
      host.ixDrafts.delete(req.requestId);
      host.post({ kind: 'permission-response', requestId: req.requestId, response: response as PermissionResponse });
      renderPermissionCards(host);
    });
    card.prepend(tabs);
    host.messagesEl.append(card);
    focusInteractionCard(host, card, focus);
  } else {
    const req = host.pendingUserInputs.get(focus.id);
    if (!req) {
      host.interactionOrder.shift();
      renderPermissionCards(host);
      return;
    }
    let draft = host.ixDrafts.get(req.requestId);
    if (!draft) { draft = createInteractionDraft(); host.ixDrafts.set(req.requestId, draft); }
    const card = renderUserInputCard(req, host.t, draft, (response) => {
      submitUserInput(host, req.requestId, response as UserInputResponse);
    });
    card.prepend(tabs);
    host.messagesEl.append(card);
    focusInteractionCard(host, card, focus);
  }
  host.scrollBottom();
}

/** 队首切换时把焦点交给卡片（键盘导航立即可用）；同卡重渲染不抢用户焦点 */
function focusInteractionCard(host: QueueHost, card: HTMLElement, focus: { type: string; id: string }): void {
  const headId = `${focus.type}:${focus.id}`;
  if (host.ixHeadId === headId) return;
  host.ixHeadId = headId;
  card.focus({ preventScroll: true });
}

export function submitUserInput(host: QueueHost, requestId: string, response: UserInputResponse): void {
  host.pendingUserInputs.delete(requestId);
  host.ixDrafts.delete(requestId);
  host.post({ kind: 'user-input-response', requestId, response });
  renderPermissionCards(host); // 队列推进到下一张
}
