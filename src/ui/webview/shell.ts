/**
 * [INPUT]: 依赖 ./render、./icons、./i18n、./events 的展示类型与 ./format 的用量格式化与 reasoningChoices 三档映射
 * [OUTPUT]: createChatShell（任务进度与差异摘要共用工作条、套餐与上下文圆环同排）、renderWelcome、renderHeaderControls、renderContextRing、renderStatus/renderResponseWait/updateSendStatus；发送准备即时反馈并续接首响等待
 * [POS]: webview 的布局层；chat.ts 持有状态，composer.ts 绑定输入行为
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { h, renderPendingResponse, processingLabel } from './render';
import { iconEl, zLogoEl, MODE_ICONS } from './icons';
import type { Translate, WvStringKey } from './i18n';
import type { ChatSessionState } from './events';
import { formatTokens, fmtContext, reasoningChoices } from './format';

const MODE_CHIP_LABEL: Record<string, string> = {
  plan: '计划模式', build: '变更前确认', edit: '自动编辑', yolo: '完全访问'
};

export function renderHeaderControls(host: {
  root: HTMLElement; messagesEl: HTMLElement; modelBtn: HTMLButtonElement;
  modeBtn: HTMLButtonElement; titleEl: HTMLElement; t: Translate; locale: string;
  session: ChatSessionState | null; defaultMode: string; updateSendAffordance(): void;
}): void {
    host.root.querySelectorAll<HTMLElement>('[data-label]').forEach(el => {
      const text = host.t(el.dataset.label as WvStringKey);
      el.title = text;
      el.setAttribute('aria-label', text);
    });
    host.root.querySelectorAll<HTMLElement>('[data-text]').forEach(el => {
      el.textContent = host.t(el.dataset.text as WvStringKey);
    });
    host.messagesEl.setAttribute('aria-label', host.t('conversation'));
    const cur = host.session?.settings.model.current ?? host.session?.settings.model.lastUsed;
    const modelInfo = cur ? host.session?.settings.model.available.find(m => m.ref.providerId === cur.providerId && m.ref.modelId === cur.modelId) : undefined;
    const level = cur?.options?.reasoningLevel ?? modelInfo?.reasoning?.defaultLevel;
    const levelLabel = reasoningChoices(modelInfo?.reasoning?.levels ?? [], level, host.locale).find(item => item.selected)?.label;
    const label = `${modelInfo?.label ?? cur?.modelId ?? 'GLM'}${levelLabel ? ' ' + levelLabel : ''}`;
    host.modelBtn.replaceChildren(h('span', { class: 'model-label' }, label), iconEl('chevronDown'));
    host.modelBtn.title = `${host.t('model')}: ${label}`;
    host.modelBtn.setAttribute('aria-label', host.modelBtn.title);
    const mode = String(host.session?.settings.mode.current ?? host.session?.projection.mode ?? host.defaultMode);
    host.modeBtn.replaceChildren(iconEl(MODE_ICONS[mode] ?? MODE_ICONS.build));
    host.modeBtn.classList.toggle('full-access', mode === 'yolo');
    const names = host.locale === 'zh-CN' ? MODE_CHIP_LABEL : { plan: 'Plan', build: 'Confirm changes', edit: 'Auto edit', yolo: 'Full access' } as Record<string, string>;
    host.modeBtn.title = `${host.t('permissions')}: ${names[mode] ?? mode}`;
    host.modeBtn.setAttribute('aria-label', host.modeBtn.title);
    host.titleEl.textContent = host.session?.info.title || host.t('newSession');
    host.titleEl.setAttribute('aria-label', `${host.titleEl.textContent}, ${host.t('chatActions')}`);
    host.updateSendAffordance();
  }

interface ResponseWaitHost {
  messagesEl: HTMLElement; t: Translate; session: ChatSessionState | null; serverState: string;
  pendingSendSessionId: string | null;
  pendingPermissions: { size: number }; pendingUserInputs: { size: number };
  scrollBottom(): void;
}

/** 消息刷新只校准首响占位，不重复构建发送按钮和上下文圆环。 */
export function renderResponseWait(host: ResponseWaitHost): void {
  if (host.pendingSendSessionId !== host.session?.info.sessionId) host.pendingSendSessionId = null;
  const preparing = host.pendingSendSessionId !== null;
  const waiting = (preparing || host.session?.projection.status === 'running') && host.serverState === 'ready'
    && !host.pendingPermissions.size && !host.pendingUserInputs.size;
  if (renderPendingResponse(host.messagesEl, host.t, waiting, preparing)) host.scrollBottom();
}

/** 准备阶段只展示等待状态；用户消息仍由 CLI 受理后的统一通道写入。 */
export function updateSendStatus(host: ResponseWaitHost, data: { sessionId: string; phase: 'preparing' | 'rejected' }): void {
  if (data.sessionId !== host.session?.info.sessionId) return;
  host.pendingSendSessionId = data.phase === 'preparing' ? data.sessionId : null;
  renderResponseWait(host);
}

/** 状态变化时更新控件，并校准首响前的等待反馈。 */
export function renderStatus(host: ResponseWaitHost & {
  updateSendAffordance(): void; renderContextRing(): void;
}): void {
  host.updateSendAffordance();
  host.renderContextRing();
  renderResponseWait(host);
}

interface ShellActions {
  sessions(): void;
  settings(): void;
  chatMenu(): void;
  newChat(): void;
  attach(): void;
  model(): void;
  mode(): void;
  context(): void;
  send(): void;
  latest(): void;
  review(): void;
}

/** 静态骨架只建一次；所有动作仍由 ChatApp 分发到现有协议桥。 */
export function createChatShell(t: Translate, a: ShellActions, quota: HTMLElement, popup: HTMLElement) {
  const button = (key: WvStringKey, icon: Parameters<typeof iconEl>[0], action: () => void, cls = 'titlebar-btn') =>
    h('button', { type: 'button', class: cls, title: t(key), 'aria-label': t(key), 'data-label': key, onclick: action }, iconEl(icon));
  const titleEl = h('button', { class: 'chat-title', type: 'button', onclick: a.chatMenu });
  const historyBtn = button('sessions', 'history', a.sessions);
  const gearBtn = button('settings', 'settings', a.settings);
  const chatMenuBtn = button('chatActions', 'more', a.chatMenu);
  const titlebar = h('header', { class: 'chat-titlebar' },
    button('back', 'back', a.sessions), titleEl,
    h('div', { class: 'titlebar-actions' }, chatMenuBtn, historyBtn, gearBtn, button('newSession', 'compose', a.newChat)));
  const banner = h('div', { class: 'banner hidden', role: 'status' });
  const messagesEl = h('div', { class: 'messages', id: 'messages', role: 'region', 'aria-label': t('conversation') });
  const overlayEl = h('div', { class: 'overlay' });
  const todoPanelEl = h('div', { class: 'todo-panel hidden' });
  const attachRow = h('div', { class: 'attach-row hidden' });
  const queuedEl = h('div', { class: 'queued-row hidden' });
  const composerInput = h('textarea', { class: 'composer-input', placeholder: t('inputPlaceholder'),
    'aria-label': t('inputPlaceholder'), rows: '2' });
  const modelBtn = h('button', { type: 'button', class: 'composer-chip model-chip',
    title: t('model'), 'aria-label': t('model'), 'aria-haspopup': 'menu', onclick: a.model }, 'GLM', iconEl('chevronDown'));
  const modeBtn = button('permissions', MODE_ICONS.build, a.mode, 'bar-icon-btn mode-btn');
  modeBtn.setAttribute('aria-haspopup', 'menu');
  const attachBtn = button('attach', 'plus', a.attach, 'bar-icon-btn');
  attachBtn.setAttribute('aria-haspopup', 'menu');
  const ctxRingBtn = h('button', { type: 'button', class: 'ctx-ring-btn hidden', onclick: a.context });
  const sendBtn = button('send', 'arrowUp', a.send, 'send-btn');
  const jumpBtn = button('latest', 'arrowDown', a.latest, 'jump-latest hidden');
  const composer = h('section', { class: 'composer', 'aria-label': t('composer') }, queuedEl,
    h('div', { class: 'composer-context' }, todoPanelEl,
      h('div', { class: 'changes-summary hidden', role: 'group' },
        h('div', { class: 'changes-stats' }),
        h('div', { class: 'changes-actions' },
          h('button', { type: 'button', class: 'changes-review', 'data-text': 'viewChanges', 'data-label': 'viewChanges', onclick: a.review }, t('viewChanges')),
          h('button', { type: 'button', class: 'bar-icon-btn changes-dismiss', title: t('dismissChanges'),
            'aria-label': t('dismissChanges'), 'data-label': 'dismissChanges' }, iconEl('close'))))),
    h('div', { class: 'composer-surface' },
      h('div', { class: 'composer-inner' }, attachRow, composerInput),
      h('div', { class: 'composer-bar' },
        h('div', { class: 'composer-bar-left' }, attachBtn, modeBtn),
        h('div', { class: 'composer-bar-right' }, quota, ctxRingBtn, modelBtn, sendBtn))));
  const fragment = document.createDocumentFragment();
  fragment.append(titlebar, banner, messagesEl, overlayEl, jumpBtn, popup, composer);
  return { fragment, banner, messagesEl, overlayEl, todoPanelEl, attachRow, queuedEl, composerInput,
    modelBtn, modeBtn, attachBtn, sendBtn, historyBtn, gearBtn, chatMenuBtn, titleEl, jumpBtn, ctxRingBtn };
}

export function renderContextRing(host: { ctxRingBtn: HTMLElement; session: ChatSessionState | null; t: Translate; authoritativeWindow(): number }): void {
    const proj = host.session?.projection;
    const btn = host.ctxRingBtn;
    const window = host.authoritativeWindow();
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
    btn.title = `${host.t('context')} ${pct}% · ${formatTokens(used)}/${fmtContext(window)} ${host.t('tokens')}`;
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
<circle cx="8" cy="8" r="${r}" fill="none" stroke="var(--vscode-panel-border,rgba(128,128,128,.35))" stroke-width="2.4"/>
<circle cx="8" cy="8" r="${r}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"
    stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(2)}" transform="rotate(-90 8 8)"/>
</svg>`;
  }

interface WelcomeOptions {
  loginRequired: boolean;
  starting: boolean;
  login(): void;
  suggest(text: string): void;
}

/** 空态使用真实 ZCode 能力；不添加没有后端支持的云端或听写按钮。 */
export function renderWelcome(container: HTMLElement, t: Translate, options: WelcomeOptions): void {
  container.replaceChildren();
  const login = options.loginRequired;
  const gate = h('div', { class: 'gate' }, zLogoEl(),
    h('h1', { class: 'gate-title' }, t(login ? 'loginRequired' : 'emptyTitle')),
    h('p', { class: 'gate-hint' }, !login && options.starting ? processingLabel(t('starting')) : t(login ? 'loginHint' : 'emptyHint')));
  if (login) gate.append(h('button', { class: 'gate-btn', onclick: options.login }, t('login')));
  else gate.append(h('div', { class: 'gate-suggestions' },
    ...(['suggestExplore', 'suggestFix', 'suggestTest'] as const).map((key, i) =>
      h('button', { class: 'gate-suggestion', onclick: () => options.suggest(t(key)) },
        iconEl((['folder', 'terminal', 'code'] as const)[i]), h('span', {}, t(key)), iconEl('arrowRight')))));
  container.append(gate);
}
