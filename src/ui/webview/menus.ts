/**
 * [INPUT]: 消费 ../bridge、../../protocol/types、./render、./icons、./clipboard、./format、./events、./i18n 和 ./quotaRings
 * [OUTPUT]: MenuHost/MenuController，统一模型与横排低/中/高思考强度（原始值发送、缺档禁用）、20px 语义权限模式、附件、聊天操作、设置、历史搜索、上下文和额度菜单，提供键盘导航/定位/焦点恢复；处理中使用统一文字扫光
 * [POS]: webview 弹层菜单唯一实现；ChatApp 装配，ComposerController 复用 slash/@ 导航设施
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { AvailableModel } from '../../protocol/types';
import type { FromWebviewMessage, QuotaUsagePayload } from '../bridge';
import { h, relTime, processingLabel } from './render';
import { MODE_ICONS, iconEl } from './icons';
import { copyText } from './clipboard';
import { formatTokens, fmtContext, sourceLabel, sourceColor, formatTokensLocale, fmtContextLocale, reasoningChoices } from './format';
import type { ChatSessionState } from './events';
import type { Locale, Translate } from './i18n';
import { quotaRingSvg, fmtIn } from './quotaRings';

/** 菜单层对宿主（ChatApp）的最小访问面 */
export interface MenuHost {
  t: Translate;
  locale: Locale;
  session: ChatSessionState | null;
  serverState: string;
  mcp: { started: number; done: boolean; configuredCount?: number; connectedCount?: number; failedCount?: number; servers?: string[]; crashed?: string[] } | null;
  mcpServers: { name: string; pid: number; source: string }[] | null;
  ctxBreakdown: { source: string; chars: number }[] | null;
  modelBtn: HTMLButtonElement;
  gearBtn: HTMLButtonElement;
  modeBtn: HTMLButtonElement;
  historyBtn: HTMLButtonElement;
  attachBtn: HTMLButtonElement;
  chatMenuBtn: HTMLButtonElement;
  defaultMode: string;
  conversationText(): string;
  onAtReference(): void;
  showError(message: string): void;
  ctxRingBtn: HTMLElement;
  quotaRingBtn: HTMLElement;
  /** 最新套餐用量载荷（quota-usage 消息留存；null=无数据弹窗不开） */
  quotaPayload: QuotaUsagePayload | null;
  composerInput: HTMLTextAreaElement;
  post(msg: FromWebviewMessage): void;
  /** 打开手机配对面板（面板本体在 chat.ts，菜单只负责入口） */
  openPairPanel(): void;
  optimisticSetModel(providerId: string, modelId: string, reasoningLevel?: string): void;
  /** 权威上下文窗口：当前模型在 available（配置权威列表）里的值；投影里的 200K 是降级值不可信 */
  authoritativeWindow(): number;
  onInput(): void;
}

export class MenuController {
  readonly popupEl: HTMLElement;
  private host: MenuHost;
  private popupAnchor: HTMLElement | null = null;
  private slashIndex = -1;
  private sessionsMenuOpen = false;

  constructor(host: MenuHost) {
    this.host = host;
    this.popupEl = h('div', { class: 'popup hidden', id: 'chat-popup', role: 'menu', tabindex: '-1' });
    this.popupEl.addEventListener('keydown', e => this.onPopupKeydown(e));
    document.addEventListener('mousedown', e => this.onDocumentMousedown(e.target as HTMLElement));
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !this.popupEl.classList.contains('hidden')) {
        e.preventDefault();
        this.hidePopup(true);
      }
    });
    window.addEventListener('resize', () => this.positionPopup());
  }

  // ═══════════════ popup 基础设施 ═══════════════

  /** 弹层定位与展示（chat.ts 的斜杠/@ 弹层共用本设施） */
  showPopup(anchor: HTMLElement, content: HTMLElement): void {
    this.popupAnchor?.setAttribute('aria-expanded', 'false');
    this.popupAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', 'chat-popup');
    this.popupEl.classList.remove('slash');
    this.slashIndex = -1;
    this.popupEl.setAttribute('aria-label', anchor.getAttribute('aria-label') || anchor.title || this.host.t('commands'));
    this.popupEl.innerHTML = '';
    this.popupEl.append(content);
    content.querySelectorAll<HTMLElement>('.menu-item:not(.static)').forEach(el => {
      if (!el.hasAttribute('role')) el.setAttribute('role', 'menuitem');
      el.tabIndex = -1;
    });
    this.popupEl.classList.remove('hidden');
    this.positionPopup();
    if (anchor.tagName === 'BUTTON') {
      (content.querySelector<HTMLElement>('input, [role="menuitemradio"][aria-checked="true"], [role="menuitem"]'))?.focus();
    }
  }

  /** 视口钳制定位：左右贴锚点侧、上下按锚点半屏取向。内容异步替换后必须重调（宽窄变化） */
  private positionPopup(): void {
    if (!this.popupAnchor) return;
    const rect = this.popupAnchor.getBoundingClientRect();
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

  hidePopup(restoreFocus = false): void {
    const anchor = this.popupAnchor;
    const hadFocus = this.popupEl.contains(document.activeElement);
    this.popupEl.classList.add('hidden');
    this.popupEl.classList.remove('slash');
    anchor?.setAttribute('aria-expanded', 'false');
    this.popupAnchor = null;
    if (restoreFocus || hadFocus) anchor?.focus();
    this.slashIndex = -1;
    this.sessionsMenuOpen = false;
  }

  /** 菜单统一键盘路径；输入框仍保留文字编辑和搜索按键。 */
  private onPopupKeydown(e: KeyboardEvent): void {
    const editing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
      this.hidePopup(true);
      return;
    }
    const items = [...this.popupEl.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], .lv-btn')]
      .filter(el => !el.hasAttribute('disabled'));
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = index;
    if (!editing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (e.target as HTMLElement).closest('.reasoning-levels')) {
      const levels = items.filter(el => el.classList.contains('reasoning-option'));
      const step = e.key === 'ArrowRight' ? 1 : -1;
      const current = levels.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      levels[(current + step + levels.length) % levels.length]?.focus();
      return;
    }
    if (e.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (e.key === 'ArrowUp') next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
    else if (!editing && e.key === 'Home') next = 0;
    else if (!editing && e.key === 'End') next = items.length - 1;
    else if (!editing && (e.key === 'Enter' || e.key === ' ')) {
      if (document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); items[index]?.click(); }
      return;
    } else return;
    e.preventDefault();
    items[next]?.focus();
  }

  /** 菜单是否正锚定在该按钮上打开 */
  isOpenFor(anchor: HTMLElement): boolean {
    return !this.popupEl.classList.contains('hidden') && this.popupAnchor === anchor;
  }

  /** 点外部关闭：click 时菜单 DOM 可能已被 onclick 重建，旧 target 脱离导致误判闪关——用 mousedown 判定 */
  onDocumentMousedown(target: HTMLElement): void {
    if (this.popupEl.contains(target) || this.popupAnchor?.contains(target)) return;
    // 触发按钮自身的点击由各自 toggle 处理（同按钮=关闭，异按钮=换菜单）
    if (target.closest?.('.bar-icon-btn, .composer-chip, .titlebar-btn, .chat-title, .ctx-ring-btn, .quota-rings')) return;
    this.hidePopup();
  }

  /** composer 按键：slash/@ 弹层打开时接管 ↑↓/Enter/Tab/Esc，返回 true 表示已消费 */
  handleComposerKeydown(e: KeyboardEvent): boolean {
    const popupOpen = !this.popupEl.classList.contains('hidden') && this.popupEl.classList.contains('slash');
    if (!popupOpen) return false;
    const items = [...this.popupEl.querySelectorAll('.menu-item')] as HTMLElement[];
    if (!items.length && e.key !== 'Escape') return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.slashIndex = e.key === 'ArrowDown'
        ? (this.slashIndex + 1) % items.length
        : this.slashIndex < 0 ? items.length - 1 : (this.slashIndex - 1 + items.length) % items.length;
      items.forEach((it, i) => it.classList.toggle('hover', i === this.slashIndex));
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && this.slashIndex >= 0) {
      e.preventDefault();
      items[this.slashIndex]?.click();
      return true;
    }
    if (e.key === 'Escape') {
      this.hidePopup();
      return true;
    }
    return false;
  }

  /** 弹层展示后重置键盘导航位次（chat.ts 的斜杠/@ 弹层展示时调用） */
  beginSlashNav(): void {
    this.slashIndex = -1;
  }

  // ═══════════════ 模型菜单 ═══════════════

  toggleModelMenu(): void {
    const { host } = this;
    if (this.isOpenFor(host.modelBtn)) { this.hidePopup(); return; }
    this.hidePopup();
    const models = host.session?.settings.model.available ?? [];
    const current = host.session?.settings.model.current ?? host.session?.settings.model.lastUsed;
    const list = h('div', { class: 'menu model-menu' });
    list.append(h('div', { class: 'menu-group' }, host.t('model')));
    const groups = new Map<string, AvailableModel[]>();
    for (const model of models) {
      const key = model.providerLabel ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(model);
    }
    const select = (m: AvailableModel, level?: string) => {
      host.optimisticSetModel(m.ref.providerId, m.ref.modelId, level);
      host.post({ kind: 'set-model', providerId: m.ref.providerId, modelId: m.ref.modelId, reasoningLevel: level });
      this.hidePopup();
    };
    for (const [group, models] of groups) {
      if (group) list.append(h('div', { class: 'menu-group provider-group' }, group));
      for (const m of models) {
        const selected = current?.providerId === m.ref.providerId && current?.modelId === m.ref.modelId;
        list.append(h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(selected),
          class: `menu-item model-item ${selected ? 'selected' : ''}`,
          onclick: () => select(m, selected ? current?.options?.reasoningLevel ?? m.reasoning?.defaultLevel : m.reasoning?.defaultLevel) },
          h('span', { class: 'menu-item-label' }, m.label),
          h('span', { class: 'menu-item-meta' }, fmtContext(m.contextWindow)),
          selected ? iconEl('check') : h('span', { class: 'menu-check-space' })));
      }
    }
    const active = models.find(m => m.ref.providerId === current?.providerId && m.ref.modelId === current?.modelId);
    if (active?.reasoning?.levels.length) {
      const levels = h('div', { class: 'reasoning-levels', role: 'group', 'aria-label': host.t('effort') });
      list.append(h('div', { class: 'menu-sep' }), h('div', { class: 'effort-row' },
        h('span', { class: 'effort-label' }, host.t('effort')), levels));
      for (const level of reasoningChoices(active.reasoning.levels, current?.options?.reasoningLevel ?? active.reasoning.defaultLevel, host.locale)) {
        const selected = level.selected;
        levels.append(h('button', { type: 'button', role: 'menuitemradio', tabindex: '-1', 'aria-checked': String(selected),
          class: `lv-btn reasoning-option ${selected ? 'active' : ''}`, disabled: !level.value,
          onclick: () => { if (level.value) select(active, level.value); } }, level.label));
      }
    }
    if (!models.length) list.append(h('div', { class: 'menu-empty' }, host.serverState === 'starting' ? processingLabel(host.t('starting')) : host.t('noResults')));
    this.showPopup(host.modelBtn, list);
  }

  // ═══════════════ 上下文菜单（圆环弹层） ═══════════════

  /** 圆环点击：上下文使用量（窗口尺寸以模型配置为准，非投影降级值） */
  toggleContextMenu(refresh = false): void {
    const { host } = this;
    if (!refresh && this.isOpenFor(host.ctxRingBtn)) {
      this.hidePopup();
      return;
    }
    if (!refresh) this.hidePopup();
    const proj = host.session?.projection;
    if (!proj) return;
    const window = host.authoritativeWindow();
    const used = Math.min(proj.contextUsed, window);
    const pct = window > 0 ? Math.round((used / window) * 1000) / 10 : 0;
    const zh = host.locale === 'zh-CN';
    const list = h('div', { class: 'menu ctx-menu' });

    // 标题行：左标题，右 已用/窗口（%）（zh 用万计量，对标桌面端"31.6万/100万（31.6%）"）
    const usedText = zh ? formatTokensLocale(used, host.locale) : formatTokens(used);
    const winText = zh ? fmtContextLocale(window, host.locale) : fmtContext(window);
    const headMeta = zh
      ? `${usedText}/${winText}（${pct}%）`
      : `${usedText}/${winText} (${pct}%)`;
    list.append(h('div', { class: 'ctx-head' },
      h('span', { class: 'ctx-title' }, host.t('contextCapacity')),
      h('span', { class: 'ctx-head-meta' }, headMeta)
    ));

    // 分段色条：填充 = 窗口占比；段 = 各来源在已用中的份额（与下方彩点同色）。
    // fill 自带 accent 底色兜底——breakdown 未达（resume/两回合间）时也不出现"空轨道"
    const bar = h('div', { class: 'ctx-segbar' });
    const fill = h('div', { class: 'ctx-segbar-fill', style: `width:${Math.min(100, pct)}%` });
    const breakdown = [...(host.ctxBreakdown ?? [])].sort((a, b) => b.chars - a.chars);
    const totalChars = breakdown.reduce((a, b) => a + b.chars, 0);
    if (totalChars > 0) {
      for (const e of breakdown) {
        fill.append(h('span', { class: 'ctx-seg', style: `width:${((e.chars / totalChars) * 100).toFixed(2)}%;background:${sourceColor(e.source)}` }));
      }
    }
    bar.append(fill);
    list.append(bar);

    // 来源行：彩点 + 标签 | 百分比右对齐（chars 收进 hover 提示）。
    // breakdown 仅随回合中段的 session.updated 携带（resume/两回合间为空）→ 占位说明，数据到达时
    // events 层 isOpenFor→toggleContextMenu(true) 会自动补刷
    const rows = h('div', { class: 'ctx-rows' });
    if (totalChars > 0) {
      for (const e of breakdown) {
        const share = Math.round((e.chars / totalChars) * 1000) / 10;
        rows.append(h('div', { class: 'ctx-row', title: `${sourceLabel(e.source, host.locale)} · ${formatTokens(e.chars)} chars` },
          h('span', { class: 'ctx-dot', style: `background:${sourceColor(e.source)}` }),
          h('span', { class: 'ctx-row-label' }, sourceLabel(e.source, host.locale)),
          h('span', { class: 'ctx-row-pct' }, `${share}%`)
        ));
      }
    } else {
      rows.append(h('div', { class: 'ctx-row ctx-row-placeholder' },
        h('span', { class: 'ctx-dot ctx-dot-placeholder' }),
        h('span', { class: 'ctx-row-label' }, host.t('ctxBreakdownPending'))));
    }
    list.append(rows);
    this.showPopup(host.ctxRingBtn, list);
  }

  // ═══════════════ 套餐用量弹层（双环点击，对标上下文弹层） ═══════════════

  /** 圆环点击：5 小时/每周套餐用量明细（大环 + 已用百分比 + 重置倒计时；数据缺失不开） */
  toggleQuotaMenu(refresh = false): void {
    const { host } = this;
    if (!refresh && this.isOpenFor(host.quotaRingBtn)) {
      this.hidePopup();
      return;
    }
    if (!refresh) this.hidePopup();
    const p = host.quotaPayload;
    if (!p || (!p.fiveHour && !p.weekly)) return;
    const list = h('div', { class: 'menu ctx-menu quota-menu' });
    list.append(h('div', { class: 'ctx-head' },
      h('span', { class: 'ctx-title' }, host.t('quotaPlanUsage')),
      p.level ? h('span', { class: 'ctx-head-meta' }, p.level) : null
    ));
    const rows = h('div', { class: 'ctx-rows' });
    const row = (win: { percent: number; resetAt: number | null } | null, labelKey: 'quotaFiveHour' | 'quotaWeekly'): void => {
      if (!win) return;
      const pct = Math.round(win.percent);
      const ring = h('span', { class: 'quota-row-ring' });
      ring.innerHTML = quotaRingSvg(pct, 22);
      const remaining = (win.resetAt ?? 0) - Date.now();
      rows.append(h('div', { class: 'ctx-row' },
        ring,
        h('div', { class: 'quota-row-text' },
          h('div', { class: 'quota-row-label' }, host.t(labelKey)),
          remaining > 0 ? h('div', { class: 'quota-row-sub' },
            host.t('quotaResetsIn', { t: fmtIn(remaining, host.locale) })) : null
        ),
        h('span', { class: 'ctx-row-pct' }, `${pct}%`)
      ));
    };
    row(p.fiveHour, 'quotaFiveHour');
    row(p.weekly, 'quotaWeekly');
    list.append(rows);
    this.showPopup(host.quotaRingBtn, list);
  }

  // ═══════════════ 导航操作与附件菜单 ═══════════════

  toggleChatMenu(): void {
    const { host } = this;
    if (this.isOpenFor(host.chatMenuBtn)) { this.hidePopup(); return; }
    this.hidePopup();
    const list = h('div', { class: 'menu' });
    list.append(h('button', { class: 'menu-item', type: 'button', onclick: () => {
      this.hidePopup();
      host.post({ kind: 'new-session' });
    } }, iconEl('compose'), h('span', {}, host.t('newSession'))));
    list.append(h('button', { class: 'menu-item', type: 'button', onclick: () => {
      this.hidePopup();
      void copyText(host.conversationText()).then(ok => { if (!ok) host.showError(host.t('copyFailed')); });
    } }, iconEl('copy'), h('span', {}, host.t('copyConversation'))));
    list.append(h('button', { class: 'menu-item', type: 'button', onclick: () => {
      this.hidePopup();
      host.post({ kind: 'open-in-desktop' });
    } }, iconEl('monitor'), h('span', {}, host.locale === 'zh-CN' ? '在 ZCode 桌面端打开' : 'Open in ZCode desktop')));
    this.showPopup(host.chatMenuBtn, list);
  }

  toggleAttachMenu(): void {
    const { host } = this;
    if (this.isOpenFor(host.attachBtn)) { this.hidePopup(); return; }
    this.hidePopup();
    const list = h('div', { class: 'menu' });
    const item = (label: string, icon: 'file' | 'at' | 'terminal', action: () => void) =>
      list.append(h('button', { type: 'button', class: 'menu-item', onclick: () => { this.hidePopup(); action(); } },
        iconEl(icon), h('span', {}, label)));
    item(host.t('attachFile'), 'file', () => host.post({ kind: 'attach-pick' }));
    item(host.t('reference'), 'at', () => host.onAtReference());
    item(host.t('commands'), 'terminal', () => { host.composerInput.value = '/'; host.composerInput.focus(); host.onInput(); });
    this.showPopup(host.attachBtn, list);
  }

  // ═══════════════ 设置菜单（保留 ZCode 独有能力入口） ═══════════════

  toggleSettingsMenu(): void {
    const { host } = this;
    if (this.isOpenFor(host.gearBtn)) {
      this.hidePopup();
      return;
    }
    this.hidePopup();
    const list = h('div', { class: 'menu' });
    const item = (label: string, onclick: () => void) =>
      list.append(h('button', { type: 'button', class: 'menu-item', onclick: () => { this.hidePopup(); onclick(); } }, h('span', {}, label)));
    if (host.serverState === 'failed') {
      item(host.t('retry'), () => host.post({ kind: 'retry-server' }));
    }
    item(host.t('pairPhone'), () => host.openPairPanel());
    item(host.locale === 'zh-CN' ? '在 ZCode 桌面端打开' : 'Open in ZCode desktop', () => host.post({ kind: 'open-in-desktop' }));
    item(host.t('mcpServers'), () => {
      host.mcpServers = null;
      this.showPopup(host.gearBtn, h('div', { class: 'menu' }, h('div', { class: 'menu-empty' }, processingLabel(this.host.t('loading')))));
      host.post({ kind: 'mcp-servers' });
    });
    item(host.t('commands'), () => { host.composerInput.value = '/'; host.composerInput.focus(); host.onInput(); });
    this.showPopup(host.gearBtn, list);
  }

  renderMcpMenu(): void {
    const { host } = this;
    // 名称真相源：process/childProcesses（mcp/list 报 workspace 池恒 disconnected，不可用）
    const list = h('div', { class: 'menu mcp-menu' });
    const m = host.mcp;
    const servers = host.mcpServers;
    if (!servers) {
      list.append(h('div', { class: 'menu-empty' }, processingLabel(this.host.t('loading'))));
    } else if (!servers.length) {
      list.append(h('div', { class: 'menu-empty' }, host.t('noResults')));
    } else {
      if (m?.done && m.configuredCount) {
        list.append(h('div', { class: 'menu-group' },
          `${host.t('mcpReady')} · ${m.connectedCount ?? 0}/${m.configuredCount ?? 0}${(m.failedCount ?? 0) ? ` · ⚠ ${m.failedCount}` : ''}`));
      }
      for (const sv of servers) {
        list.append(h('div', { class: 'menu-item static', title: `${sv.name} · pid ${sv.pid}` },
          h('span', { class: 'menu-item-label' },
            h('span', { class: 'mcp-dot ok' }),
            h('span', { class: 'mcp-server-name' }, sv.name)
          ),
          h('span', { class: 'menu-item-meta' }, host.t('mcpConnected'))
        ));
      }
    }
    this.showPopup(host.gearBtn, list);
    if (!servers) host.post({ kind: 'mcp-servers' });
  }

  // ═══════════════ 模式菜单 ═══════════════

  toggleModeMenu(): void {
    const { host } = this;
    if (this.isOpenFor(host.modeBtn)) {
      this.hidePopup();
      return;
    }
    this.hidePopup();
    const cur = String(host.session?.settings.mode.current ?? host.session?.projection.mode ?? host.defaultMode);
    const list = h('div', { class: 'menu mode-menu' });
    list.append(h('div', { class: 'menu-group' }, host.t('modes')));
    // 菜单永远可开：四模式是静态选项，不依赖会话数据（菜单与输入区入口共用 MODE_ICONS 语义映射）
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
    const zh = host.locale === 'zh-CN';
    for (const mode of ['plan', 'build', 'edit', 'yolo'] as const) {
      const icon = iconEl(MODE_ICONS[mode]);
      icon.classList.add('mode-icon');
      const row = h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(cur === mode), class: `menu-item mode-item${mode === 'yolo' ? ' full-access' : ''} ${cur === mode ? 'selected' : ''}`, onclick: () => { host.post({ kind: 'set-mode', mode }); this.hidePopup(); } },
        icon,
        h('div', { class: 'mode-text' },
          h('div', { class: 'mode-name' }, zh ? NAMES[mode].zh : NAMES[mode].en),
          h('div', { class: 'mode-desc' }, zh ? DESCS[mode].zh : DESCS[mode].en)
        ),
        cur === mode ? iconEl('check') : null
      );
      list.append(row);
    }
    this.showPopup(host.modeBtn, list);
  }

  // ═══════════════ 历史搜索（最近聊天 → 搜索过滤 → 点击 resume） ═══════════════

  toggleSessionsMenu(): void {
    if (this.isOpenFor(this.host.historyBtn)) {
      this.hidePopup();
      return;
    }
    this.hidePopup();
    this.sessionsMenuOpen = true;
    this.showPopup(this.host.historyBtn, h('div', { class: 'menu' }, h('div', { class: 'menu-empty' }, processingLabel(this.host.t('loading')))));
    this.host.post({ kind: 'list-sessions' });
  }

  renderSessionsMenu(sessions: { sessionId: string; title: string; updatedAt: number; mode: string; status: string }[]): void {
    if (!this.sessionsMenuOpen) return;
    const { host } = this;
    const list = h('div', { class: 'menu sessions-menu' });
    const search = h('input', { class: 'menu-search', type: 'search', placeholder: host.t('searchSessions'),
      'aria-label': host.t('searchSessions') });
    const rows = h('div', { class: 'session-results' });
    list.append(h('div', { class: 'menu-group' }, host.t('recentChats')),
      h('div', { class: 'menu-search-wrap' }, iconEl('search'), search), rows);
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    const paint = () => {
      rows.replaceChildren();
      const filtered = sorted.filter(s => s.title.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
      if (!filtered.length) rows.append(h('div', { class: 'menu-empty' }, host.t(sorted.length ? 'noResults' : 'noSessions')));
      for (const s of filtered) {
        const selected = s.sessionId === host.session?.info.sessionId;
        rows.append(h('button', { type: 'button', role: 'menuitemradio', tabindex: '-1',
          'aria-checked': String(selected), class: `menu-item session-menu-item ${selected ? 'selected' : ''}`,
          onclick: () => { this.hidePopup(); host.post({ kind: 'resume', sessionId: s.sessionId }); } },
          h('span', { class: 'session-menu-name', title: s.title || host.t('newSession') }, s.status === 'running' ? processingLabel(s.title || host.t('newSession')) : s.title || host.t('newSession')),
          h('span', { class: 'session-menu-meta' }, relTime(s.updatedAt, host.t)),
          s.status === 'running' ? h('span', { class: 'session-item-running', title: host.t('running') }) : selected ? iconEl('check') : null));
      }
      this.positionPopup();
    };
    search.addEventListener('input', paint);
    this.showPopup(host.historyBtn, list);
    paint();
    search.focus();
  }
}
