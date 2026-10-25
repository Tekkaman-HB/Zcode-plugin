/**
 * [INPUT]: 消费 ../bridge 的 QuotaUsagePayload、./render 的 h、./i18n 的 Translate
 * [OUTPUT]: createQuotaRings（可键盘激活的套餐用量按钮）、quotaRingSvg/fmtIn（弹层复用的 SVG 与倒计时）
 * [POS]: webview 套餐额度层，shell.ts 挂载于 composer-status；quota-usage 驱动 update，menus.ts 展示详情
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 视觉与 ctx-ring-btn 完全同款（16px 环 + 2.4 线宽 + charts 色梯度）；
 * 数据由宿主 QuotaMonitor 轮询推送（cc-switch 同款通道，见 src/quotaUsage.ts），
 * webview 侧零网络零状态——update 即全量重绘，数据缺失整组隐藏。
 */
import type { QuotaUsagePayload, QuotaWindowUsage } from '../bridge';
import { h } from './render';
import type { Translate } from './i18n';

/** 单环 SVG：颜色随占用率绿→黄→橙（与 ctx-ring 同梯度），满环=100%；px 缩放 viewBox（弹层用大环） */
export function quotaRingSvg(pct: number, px = 16): string {
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const color = pct < 60 ? 'var(--vscode-charts-green)' : pct < 85 ? 'var(--vscode-charts-yellow)' : 'var(--vscode-charts-orange)';
  const clamped = Math.min(100, Math.max(0, pct));
  return `<svg width="${px}" height="${px}" viewBox="0 0 16 16" aria-hidden="true">
<circle cx="8" cy="8" r="${r}" fill="none" stroke="var(--vscode-panel-border,rgba(128,128,128,.35))" stroke-width="2.4"/>
<circle cx="8" cy="8" r="${r}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"
 stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - clamped / 100)).toFixed(2)}" transform="rotate(-90 8 8)"/>
</svg>`;
}

/** 距重置的剩余时长（未来时）→ 紧凑文案；不足 1 分钟归零 */
export function fmtIn(ms: number, locale: string): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(total / 1440);
  const hh = Math.floor((total % 1440) / 60);
  const mm = total % 60;
  const zh = locale === 'zh-CN';
  if (d > 0) return zh ? `${d}天${hh}小时` : `${d}d ${hh}h`;
  if (hh > 0) return zh ? `${hh}小时${mm}分` : `${hh}h ${mm}m`;
  return zh ? `${mm}分钟` : `${mm}m`;
}

export interface QuotaRings {
  el: HTMLElement;
  update(payload: QuotaUsagePayload | null, t: Translate, locale: string): void;
}

export function createQuotaRings(): QuotaRings {
  const el = h('button', { type: 'button', class: 'quota-rings hidden', 'aria-haspopup': 'menu' });
  const five = h('span', { class: 'quota-ring hidden' });
  const week = h('span', { class: 'quota-ring hidden' });
  el.append(five, week);

  const renderRing = (span: HTMLElement, win: QuotaWindowUsage | null, label: string, prefix: string, t: Translate, locale: string): void => {
    if (!win) {
      span.classList.add('hidden');
      span.title = '';
      return;
    }
    span.classList.remove('hidden');
    span.innerHTML = quotaRingSvg(win.percent);
    const parts = [`${prefix}${label} ${t('quotaUsed', { pct: String(Math.round(win.percent)) })}`];
    const remaining = (win.resetAt ?? 0) - Date.now();
    if (remaining > 0) parts.push(t('quotaResetsIn', { t: fmtIn(remaining, locale) }));
    span.title = parts.join(' · ');
  };

  return {
    el,
    update(payload, t, locale) {
      const p = payload ?? { fiveHour: null, weekly: null, level: null };
      const lvl = p.level ? `${p.level} · ` : '';
      renderRing(five, p.fiveHour, t('quotaFiveHour'), lvl, t, locale);
      // 套餐等级只标注一次：5h 环已带则周环不带
      renderRing(week, p.weekly, t('quotaWeekly'), p.fiveHour ? '' : lvl, t, locale);
      el.classList.toggle('hidden', !p.fiveHour && !p.weekly);
      el.setAttribute('aria-label', [t('quotaPlanUsage'), five.title, week.title].filter(Boolean).join(' · '));
    }
  };
}
