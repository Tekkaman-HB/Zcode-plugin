/**
 * [INPUT]: 依赖 ../bridge 的配对载荷、./render 的 DOM 工厂与 processingLabel、./icons 和 ./i18n
 * [OUTPUT]: 对外提供 PanelsController/PanelsHost，按原 URL 查找附件预览，管理手机配对对话框
 * [POS]: webview 的模态展示层；ChatApp 保留载荷，控制器处理焦点、键盘与弹层生命周期
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { PairingPanelPayload, FromWebviewMessage } from '../bridge';
import type { Translate, Locale } from './i18n';
import { h, processingLabel } from './render';
import { phoneIconEl, iconEl } from './icons';

export interface PanelsHost {
  root: HTMLElement;
  t: Translate;
  locale: Locale;
  previewRegistry: Map<string, string>;
  previewEl: HTMLElement | null;
  pairEl: HTMLElement | null;
  pairPanel: PairingPanelPayload | null;
  post(msg: FromWebviewMessage): void;
  showError(message: string): void;
}

export class PanelsController {
  private lastPairSvg: string | null = null;
  private previousFocus: HTMLElement | null = null;
  constructor(private host: PanelsHost) {
    document.addEventListener('keydown', e => {
      const box = host.pairEl ?? host.previewEl;
      if (!box) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (host.pairEl) this.closePairPanel();
        else this.closePreview();
      } else if (e.key === 'Tab') {
        const buttons = [...box.querySelectorAll<HTMLElement>('button, [href], input, textarea, iframe')];
        const first = buttons[0] ?? box;
        const last = buttons[buttons.length - 1] ?? box;
        if (!box.contains(document.activeElement) || document.activeElement === box
          || (!e.shiftKey && document.activeElement === last) || (e.shiftKey && document.activeElement === first)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    });
  }

  openPreview(name: string, url?: string): void {
    const src = this.host.previewRegistry.get(url || name)
      ?? (url && /^(data:|https:)/.test(url) ? url : undefined);
    this.closePreview();
    this.previousFocus = document.activeElement as HTMLElement;
    if (!src) {
      this.host.showError(this.host.locale === 'zh-CN' ? '该附件无预览数据' : 'No preview data for this attachment');
      return;
    }
    const isImg = /^data:image\//.test(src) || /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(url ?? name) || this.host.previewRegistry.has(name);
    const box = h('div', { class: 'preview-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': name, tabindex: '-1' });
    const body = isImg
      ? h('img', { class: 'preview-img', src, alt: name })
      : h('iframe', { class: 'preview-frame', src, title: name });
    const close = h('button', { class: 'preview-close', title: this.host.t('cancel') }, iconEl('close'));
    (close as HTMLElement).addEventListener('click', (e) => { e.stopPropagation(); this.closePreview(); });
    (box as HTMLElement).addEventListener('click', () => this.closePreview());
    (body as HTMLElement).addEventListener('click', (e) => e.stopPropagation());
    box.append(body, close, h('div', { class: 'preview-name' }, name));
    this.host.root.append(box);
    this.host.previewEl = box;
    box.focus();
  }

  closePreview(): void {
    if (!this.host.previewEl) return;
    this.host.previewEl.remove();
    this.host.previewEl = null;
    this.previousFocus?.focus();
    this.previousFocus = null;
  }

  openPairPanel(): void {
    this.closePairPanel();
    this.previousFocus = document.activeElement as HTMLElement;
    this.host.post({ kind: 'pair-phone' });
    this.renderPairPanel();
  }

  closePairPanel(): void {
    if (!this.host.pairEl) return;
    this.host.pairEl.remove();
    this.host.pairEl = null;
    this.previousFocus?.focus();
    this.previousFocus = null;
  }

  renderPairPanel(): void {
    const focused = this.host.pairEl?.contains(document.activeElement) ? (document.activeElement as HTMLElement).textContent : null;
    this.host.pairEl?.remove();
    const p = this.host.pairPanel;
    const status = p?.status ?? 'starting';
    const statusLabel =
      status === 'waiting' ? this.host.t('pairWaiting')
      : status === 'active' ? this.host.t('pairActive')
      : status === 'error' ? this.host.t('pairError')
      : status === 'idle' ? this.host.t('pairStopped')
      : this.host.t('pairStarting');
    const box = h('div', { class: 'preview-backdrop pair-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': this.host.t('pairTitle'), tabindex: '-1' });
    (box as HTMLElement).addEventListener('click', () => this.closePairPanel());
    const card = h('div', { class: 'pair-card' });
    (card as HTMLElement).addEventListener('click', (e) => e.stopPropagation());

    const head = h('div', { class: 'pair-head' }, phoneIconEl(), h('span', {}, this.host.t('pairTitle')));
    const stateRow = h('div', { class: `pair-state ${status}` },
      h('span', { class: 'pair-dot' }),
      status === 'starting' ? processingLabel(statusLabel) : h('span', {}, statusLabel)
    );
    const qrBox = h('div', { class: 'pair-qr' });
    // starting（重连中）保留上次二维码置灰显示——QR→"…"→QR 的来回替换就是肉眼闪烁
    if (p?.qrSvg) {
      this.lastPairSvg = p.qrSvg;
    }
    const svg = p?.qrSvg ?? (status === 'starting' ? this.lastPairSvg : null);
    if (svg) {
      qrBox.innerHTML = svg;
      if (!p?.qrSvg) qrBox.classList.add('stale');
    } else if (status === 'starting' || status === 'waiting') {
      qrBox.append(h('div', { class: 'pair-qr-pending' }, '…'));
    }
    if (p?.message) {
      stateRow.append(h('div', { class: 'pair-message' }, p.message));
    }
    const hint = h('div', { class: 'pair-hint' }, this.host.t('pairHint'));
    const busyHint = h('div', { class: 'pair-hint sub' }, this.host.t('pairBusyHint'));
    const identityHint = p?.identity ? h('div', { class: 'pair-hint sub' }, p.identity) : null;
    const actions = h('div', { class: 'pair-actions' });
    if (p?.qrUrl) {
      actions.append(h('button', { class: 'pair-btn', onclick: () => this.host.post({ kind: 'pair-copy-link', url: p.qrUrl! }) }, this.host.t('pairCopyLink')));
    }
    actions.append(h('button', { class: 'pair-btn', onclick: () => this.host.post({ kind: 'pair-refresh' }) }, this.host.t('pairRefresh')));
    actions.append(
      status === 'idle'
        ? h('button', { class: 'pair-btn primary', onclick: () => this.host.post({ kind: 'pair-phone' }) }, this.host.t('pairPhone'))
        : h('button', { class: 'pair-btn', onclick: () => this.host.post({ kind: 'pair-stop' }) }, this.host.t('pairStop'))
    );
    const close = h('button', { class: 'preview-close', title: this.host.t('cancel') }, iconEl('close'));
    (close as HTMLElement).addEventListener('click', (e) => { e.stopPropagation(); this.closePairPanel(); });

    card.append(head, stateRow, qrBox, hint, busyHint, ...(identityHint ? [identityHint] : []), actions);
    box.append(card, close);
    this.host.root.append(box);
    this.host.pairEl = box;
    const buttons = [...box.querySelectorAll('button')];
    (buttons.find(b => focused && b.textContent === focused) ?? buttons[0] ?? box).focus();
  }
}

