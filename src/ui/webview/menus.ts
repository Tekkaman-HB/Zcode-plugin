/**
 * [INPUT]: 消费 ../bridge 的 FromWebviewMessage、../../protocol/types、./render 的 h()/relTime()、./icons 的 MODE_ICONS、./format、./events 的 ChatSessionState、./i18n
 * [OUTPUT]: 对外提供 MenuHost 接口与 MenuController（弹层菜单控制器：模型/上下文/齿轮/模式/历史会话菜单 + popup 定位设施与 composer 弹层按键导航）
 * [POS]: webview 的菜单层——popup 类菜单的唯一居所；chat.ts 构建并委托，斜杠/@ 弹层因需改写输入框文本留在 chat.ts（经 public showPopup 共用定位设施）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { AvailableModel } from '../../protocol/types';
import type { FromWebviewMessage } from '../bridge';
import { h, relTime } from './render';
import { MODE_ICONS } from './icons';
import { formatTokens, fmtContext, sourceLabel, sourceColor, formatTokensLocale, fmtContextLocale } from './format';
import type { ChatSessionState } from './events';
import type { Locale, Translate } from './i18n';

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
  ctxRingBtn: HTMLElement;
  composerInput: HTMLTextAreaElement;
  post(msg: FromWebviewMessage): void;
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
    this.popupEl = h('div', { class: 'popup hidden' });
  }

  // ═══════════════ popup 基础设施 ═══════════════

  /** 弹层定位与展示（chat.ts 的斜杠/@ 弹层共用本设施） */
  showPopup(anchor: HTMLElement, content: HTMLElement): void {
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

  hidePopup(): void {
    this.popupEl.classList.add('hidden');
    this.popupAnchor = null;
    this.slashIndex = -1;
    this.sessionsMenuOpen = false;
  }

  /** 菜单是否正锚定在该按钮上打开 */
  isOpenFor(anchor: HTMLElement): boolean {
    return !this.popupEl.classList.contains('hidden') && this.popupAnchor === anchor;
  }

  /** 点外部关闭：click 时菜单 DOM 可能已被 onclick 重建，旧 target 脱离导致误判闪关——用 mousedown 判定 */
  onDocumentMousedown(target: HTMLElement): void {
    if (this.popupEl.contains(target)) return;
    // 触发按钮自身的点击由各自 toggle 处理（同按钮=关闭，异按钮=换菜单）
    if (target.closest?.('.bar-icon-btn, .composer-chip, .titlebar-btn, .ctx-ring-btn')) return;
    this.hidePopup();
  }

  /** composer 按键：slash/@ 弹层打开时接管 ↑↓/Enter/Tab/Esc，返回 true 表示已消费 */
  handleComposerKeydown(e: KeyboardEvent): boolean {
    const popupOpen = !this.popupEl.classList.contains('hidden') && this.popupEl.classList.contains('slash');
    if (!popupOpen) return false;
    const items = [...this.popupEl.querySelectorAll('.menu-item')] as HTMLElement[];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.slashIndex = e.key === 'ArrowDown'
        ? (this.slashIndex + 1) % items.length
        : (this.slashIndex - 1 + items.length) % items.length;
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
    if (this.isOpenFor(host.modelBtn)) {
      this.hidePopup();
      return;
    }
    this.hidePopup();
    const models = host.session?.settings.model.available ?? [];
    const current = host.session?.settings.model.current;
    const groups = new Map<string, AvailableModel[]>();
    for (const m of models) {
      const key = m.providerLabel ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    const list = h('div', { class: 'menu model-menu' });
    for (const [group, items] of groups) {
      list.append(h('div', { class: 'menu-group' }, group));
      for (const m of items) {
        const selected = current?.providerId === m.ref.providerId && current?.modelId === m.ref.modelId;
        // 行布局：模型名左（可省略），1M 窗口标识与档位组推右（meta 自带 margin-left:auto）
        const row = h('div', { class: `menu-item model-item ${selected ? 'selected' : ''}` },
          h('span', { class: 'menu-item-label' }, m.label),
          h('span', { class: 'menu-item-meta' }, `${fmtContext(m.contextWindow)}`),
          m.reasoning
            ? h('span', { class: 'reasoning-levels' },
                ...m.reasoning.levels.map((lv) =>
                  h('button', {
                    class: `lv-btn ${selected && current?.options?.reasoningLevel === lv.value ? 'active' : ''}`,
                    title: `${host.t('reasoning')}: ${lv.label}`,
                    onclick: () => {
                      host.optimisticSetModel(m.ref.providerId, m.ref.modelId, lv.value);
                      host.post({ kind: 'set-model', providerId: m.ref.providerId, modelId: m.ref.modelId, reasoningLevel: lv.value });
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
          host.optimisticSetModel(m.ref.providerId, m.ref.modelId, lvl);
          host.post({ kind: 'set-model', providerId: m.ref.providerId, modelId: m.ref.modelId, reasoningLevel: lvl });
          this.hidePopup();
        });
        list.append(row);
      }
    }
    if (!models.length) {
      const connecting = host.serverState === 'starting' || host.serverState === 'stopped';
      list.append(h('div', { class: 'menu-empty' }, connecting ? host.t('starting') : '—'));
    }
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

  // ═══════════════ 配置收纳（齿轮弹层，对标 Claude Code settings 菜单） ═══════════════

  toggleSettingsMenu(): void {
    const { host } = this;
    if (this.isOpenFor(host.gearBtn)) {
      this.hidePopup();
      return;
    }
    this.hidePopup();
    const list = h('div', { class: 'menu' });
    const item = (label: string, onclick: () => void) =>
      list.append(h('div', { class: 'menu-item', onclick: () => { this.hidePopup(); onclick(); } }, h('span', {}, label)));
    if (host.serverState === 'failed') {
      item(host.t('retry'), () => host.post({ kind: 'retry-server' }));
    }
    item(host.t('mcpServers'), () => {
      host.mcpServers = null;
      this.showPopup(host.gearBtn, h('div', { class: 'menu' }, h('div', { class: 'menu-empty' }, '…')));
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
      list.append(h('div', { class: 'menu-empty' }, '…'));
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
    const cur = String(host.session?.settings.mode.current ?? host.session?.projection.mode ?? '');
    const list = h('div', { class: 'menu mode-menu' });
    list.append(h('div', { class: 'menu-group' }, host.t('modes')));
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
    const zh = host.locale === 'zh-CN';
    for (const mode of ['plan', 'build', 'edit', 'yolo'] as const) {
      const icon = h('span', { class: 'mode-icon' });
      icon.innerHTML = MODE_ICONS[mode] ?? '';
      const row = h('div', { class: `menu-item mode-item ${cur === mode ? 'selected' : ''}`, onclick: () => { host.post({ kind: 'set-mode', mode }); this.hidePopup(); } },
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
    const curSel = host.session?.settings.model.current ?? host.session?.settings.model.lastUsed;
    const modelInfo = curSel
      ? host.session?.settings.model.available.find((m) => m.ref.providerId === curSel.providerId && m.ref.modelId === curSel.modelId)
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
              host.optimisticSetModel(curSel.providerId, curSel.modelId, lv.value);
              host.post({ kind: 'set-model', providerId: curSel.providerId, modelId: curSel.modelId, reasoningLevel: lv.value });
            }
            this.hidePopup();
          }
        }))
      );
      list.append(h('div', { class: 'menu-item static effort-row' },
        h('span', { class: 'effort-label' }, `${host.t('effort')} (${levels[currentIdx]?.label ?? current})`),
        dots
      ));
    }
    this.showPopup(host.modeBtn, list);
  }

  // ═══════════════ 历史会话下拉（Claude Code 同款：时钟按钮 → 会话列表 → 点击 resume） ═══════════════

  toggleSessionsMenu(): void {
    if (this.isOpenFor(this.host.historyBtn)) {
      this.hidePopup();
      return;
    }
    this.hidePopup();
    this.sessionsMenuOpen = true;
    this.showPopup(this.host.historyBtn, h('div', { class: 'menu' }, h('div', { class: 'menu-empty' }, '…')));
    this.host.post({ kind: 'list-sessions' });
  }

  renderSessionsMenu(sessions: { sessionId: string; title: string; updatedAt: number; mode: string; status: string }[]): void {
    if (!this.sessionsMenuOpen) return;
    const list = h('div', { class: 'menu' });
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
    if (!sorted.length) {
      list.append(h('div', { class: 'menu-empty' }, this.host.t('noSessions')));
    }
    for (const s of sorted) {
      list.append(h('div', {
        class: 'menu-item session-menu-item',
        onclick: () => {
          this.host.post({ kind: 'resume', sessionId: s.sessionId });
          this.hidePopup();
        }
      },
        h('span', { class: 'session-menu-title' }, s.title || '(untitled)'),
        h('span', { class: 'menu-item-meta' },
          `${s.mode} · ${relTime(s.updatedAt, this.host.t)}${s.status === 'running' ? ' ●' : ''}`)
      ));
    }
    this.popupEl.innerHTML = '';
    this.popupEl.append(list);
  }
}
