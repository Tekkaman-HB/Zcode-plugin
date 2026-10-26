/**
 * [INPUT]: 依赖 ../bridge 的附件/消息契约、./render 的 DOM 工厂、./events 的会话快照、./i18n 和 ./icons
 * [OUTPUT]: 对外提供 ComposerController/ComposerHost，按原 URL 回填消息缩略图，负责输入、附件、引用、斜杠命令、发送/停止和队列展示
 * [POS]: webview 输入交互层；ChatApp 是状态唯一持有者，菜单导航委托 MenuController
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { AttachmentRef, DirEntry, FromWebviewMessage } from '../bridge';
import type { ChatSessionState } from './events';
import type { Translate, Locale } from './i18n';
import { h } from './render';
import { iconEl } from './icons';

export interface ComposerHost {
  t: Translate;
  locale: Locale;
  session: ChatSessionState | null;
  composerInput: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  attachRow: HTMLElement;
  messagesEl: HTMLElement;
  queuedEl: HTMLElement;
  queuedCount: number;
  queuedItems: { id: string; content: string }[];
  attachments: AttachmentRef[];
  atDir: string;
  dirEntries: { dir: string; entries: DirEntry[] } | null;
  popupEl: HTMLElement;
  previewEl: HTMLElement | null;
  pasteSeq: number;
  pastePending: Map<string, string>;
  previewRegistry: Map<string, string>;
  followOutput: boolean;
  post(msg: FromWebviewMessage): void;
  isBusyLike(): boolean;
  updateSendAffordance(): void;
  showPopup(anchor: HTMLElement, content: HTMLElement): void;
  hidePopup(): void;
  closePreview(): void;
  handleComposerKeydown(e: KeyboardEvent): boolean;
}

export class ComposerController {
  private queueSig = '';
  private queueSeenIds = new Set<string>();
  constructor(private host: ComposerHost) {}

  hydrateAttachmentThumbs(): void {
    this.host.messagesEl.querySelectorAll('.msg-attachment-img .msg-attach-thumb').forEach((img) => {
      const el = img as HTMLImageElement;
      if (el.getAttribute('src')) return;
      const chip = el.closest('.msg-attachment-img') as HTMLElement | null;
      const name = chip?.querySelector('.attach-chip-name')?.textContent ?? '';
      const url = el.dataset.attachmentUrl;
      const data = this.host.previewRegistry.get(url || name);
      if (data) { el.src = data; el.hidden = false; }
    });
  }

  bind(): void {
    const host = this.host;
    host.composerInput.addEventListener('keydown', e => this.onKeydown(e));
    host.composerInput.addEventListener('input', () => this.onInput());
    host.composerInput.addEventListener('paste', (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find(x => x.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (!file) return;
      e.preventDefault();
      if (!host.attachments.length && !host.pastePending.size) host.pasteSeq = 0;
      const name = host.locale === 'zh-CN' ? `图片${++host.pasteSeq}.png` : `Image${++host.pasteSeq}.png`;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') return;
        host.pastePending.set(name, reader.result);
        host.previewRegistry.set(name, reader.result);
        host.updateSendAffordance();
        host.post({ kind: 'save-image', dataUrl: reader.result, name });
      };
      reader.readAsDataURL(file);
    });
  }

  renderQueued(): void {
    if (this.host.queuedCount <= 0 || !this.host.queuedItems.length) {
      this.host.queuedCount = 0;
      this.host.queuedItems = [];
      this.queueSig = '';
      this.queueSeenIds.clear();
      this.host.queuedEl.innerHTML = '';
      this.host.queuedEl.classList.add('hidden');
      return;
    }
    const sig = `${this.host.queuedCount}\u0000${this.host.queuedItems.map((q) => `${q.id}\u0000${q.content}`).join('\u0001')}`;
    if (sig === this.queueSig) return; // 内容未变：连发的 queued-update 不重建不闪
    const prevIds = this.queueSeenIds;
    this.queueSeenIds = new Set(this.host.queuedItems.map((q) => q.id));
    this.queueSig = sig;
    this.host.queuedEl.classList.remove('hidden');
    this.host.queuedEl.innerHTML = '';
    for (const q of this.host.queuedItems) {
      this.host.queuedEl.append(h('div', { class: `queued-item${prevIds.has(q.id) ? ' queued-item-kept' : ''}` },
        h('div', { class: 'queued-text', title: q.content }, q.content),
        h('div', { class: 'queued-actions' },
          h('button', {
            class: 'queued-btn primary',
            title: this.host.t('sendNow'),
            onclick: () => this.host.post({ kind: 'prioritize-queue-item', id: q.id })
          }, this.host.t('sendNow')),
          h('button', {
            class: 'queued-btn',
            title: this.host.t('cancel'),
            onclick: () => this.host.post({ kind: 'remove-queue-item', id: q.id })
          }, iconEl('close'))
        )
      ));
    }
  }

  renderAttachRow(): void {
    this.host.attachRow.innerHTML = '';
    if (!this.host.attachments.length) {
      this.host.attachRow.classList.add('hidden');
      return;
    }
    this.host.attachRow.classList.remove('hidden');
    for (const a of this.host.attachments) {
      const isImg = Boolean(a.dataUrl) || a.mime?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name);
      const preview = isImg && a.dataUrl
        ? h('img', { class: 'attach-thumb', src: a.dataUrl, alt: '' })
        : null;
      this.host.attachRow.append(h('span', { class: 'attach-chip', title: a.path },
        preview,
        h('span', { class: 'attach-chip-name' }, a.name),
        h('button', { class: 'attach-chip-x', title: this.host.t('cancel'), onclick: () => {
          this.host.attachments = this.host.attachments.filter((x) => x !== a);
          this.renderAttachRow();
          this.host.updateSendAffordance();
        } }, iconEl('close'))
      ));
    }
  }

  onAtReference(): void {
    const input = this.host.composerInput;
    input.focus();
    const at = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, at) + '@' + input.value.slice(input.selectionEnd ?? at);
    input.setSelectionRange(at + 1, at + 1);
    this.onInput();
  }

  renderAtPopup(): void {
    const input = this.host.composerInput;
    const m = /@([^@\s]*)$/.exec(input.value.slice(0, input.selectionStart ?? input.value.length));
    if (!m) {
      this.host.hidePopup();
      return;
    }
    const query = m[1];
    // 输入含路径分隔 → 解析出目标目录与过滤词
    const slash = query.lastIndexOf('/');
    const dirPart = slash >= 0 ? query.slice(0, slash) : '';
    const filterPart = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase();
    if (this.host.dirEntries?.dir !== dirPart) {
      this.host.atDir = dirPart;
      this.host.post({ kind: 'list-files', dir: dirPart });
      this.host.showPopup(input, h('div', { class: 'menu' }, h('div', { class: 'menu-empty' }, '…')));
      this.host.popupEl.classList.add('slash');
      return;
    }
    const entries = (this.host.dirEntries?.dir === this.host.atDir ? this.host.dirEntries.entries : null) ?? [];
    const matches = entries.filter((e) => e.name.toLowerCase().includes(filterPart)).slice(0, 14);
    const list = h('div', { class: 'menu at-menu' });
    list.append(h('div', { class: 'menu-group at-crumbs' }, this.host.atDir ? `@${this.host.atDir}/` : '@'));
    // 返回上级
    if (this.host.atDir) {
      list.append(h('button', {
        type: 'button', class: 'menu-item slash-item',
        onclick: () => this.navigateAt(this.host.atDir.includes('/') ? this.host.atDir.slice(0, this.host.atDir.lastIndexOf('/')) : '')
      }, iconEl('folder'), h('span', { class: 'slash-name' }, '..')));
    }
    if (!matches.length && !this.host.atDir) {
      list.append(h('div', { class: 'menu-empty' }, this.host.t('noResults')));
    }
    for (const e of matches) {
      if (e.kind === 'dir') {
        const dir = this.host.atDir ? `${this.host.atDir}/${e.name}` : e.name;
        list.append(h('button', {
          type: 'button', class: 'menu-item slash-item',
          onclick: () => this.navigateAt(dir)
        }, iconEl('folder'), h('span', { class: 'slash-name' }, e.name)));
      } else {
        const file = this.host.atDir ? `${this.host.atDir}/${e.name}` : e.name;
        list.append(h('button', {
          type: 'button', class: 'menu-item slash-item',
          onclick: () => {
            input.value = input.value.replace(/@([^@\s]*)$/, `@${file} `);
            this.host.hidePopup();
            input.focus();
            this.onInput();
          }
        }, iconEl('file'), h('span', { class: 'slash-name' }, e.name)));
      }
    }
    this.host.showPopup(input, list);
    this.host.popupEl.classList.add('slash');
    
  }

  navigateAt(dir: string): void {
    const input = this.host.composerInput;
    input.value = input.value.replace(/@([^@\s]*)$/, `@${dir ? dir + '/' : ''}`);
    const pos = input.value.length;
    input.setSelectionRange(pos, pos);
    this.host.atDir = dir;
    this.host.dirEntries = null;
    this.host.post({ kind: 'list-files', dir });
    this.host.showPopup(input, h('div', { class: 'menu' }, h('div', { class: 'menu-empty' }, '…')));
    this.host.popupEl.classList.add('slash');
    input.focus();
  }

  onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.host.previewEl) {
      this.host.closePreview();
      return;
    }
    if (this.host.handleComposerKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.onSend();
    }
  }

  onInput(): void {
    const input = this.host.composerInput;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    this.host.updateSendAffordance();
    const v = input.value;
    const atMatch = /@([^@\s]*)$/.exec(v.slice(0, input.selectionStart ?? v.length));
    if (atMatch) {
      this.renderAtPopup();
      return;
    }
    if (v.startsWith('/')) {
      const query = v.slice(1).split(' ')[0].toLowerCase();
      const cmds = (this.host.session?.slashCommands ?? []).filter((c) => c.name.startsWith(query));
      if (cmds.length) this.showSlashPopup(cmds);
      else this.host.hidePopup();
    } else {
      this.host.hidePopup();
    }
  }

  showSlashPopup(cmds: { name: string; description: string }[]): void {
    const list = h('div', { class: 'menu' });
    for (const c of cmds.slice(0, 10)) {
      list.append(h('button', {
        type: 'button', class: 'menu-item slash-item',
        onclick: () => {
          this.host.composerInput.value = `/${c.name} `;
          this.host.hidePopup();
          this.host.composerInput.focus();
          this.onInput();
        }
      },
      h('span', { class: 'slash-name' }, `/${c.name}`),
      h('span', { class: 'menu-item-meta' }, c.description.slice(0, 60))
      ));
    }
    this.host.showPopup(this.host.composerInput, list);
    this.host.popupEl.classList.add('slash');
    
  }

  onSend(): void {
    if (this.host.sendBtn.disabled) return;
    // 停止态判定：运行中/后台任务中且输入框为空 → 点击=中止
    const running = this.host.isBusyLike();
    const hasContent = this.host.composerInput.value.trim().length > 0 || this.host.attachments.length > 0;
    if (running && !hasContent) {
      this.host.post({ kind: 'stop' });
      return;
    }
    const text = this.host.composerInput.value.trim();
    if (!text && !this.host.attachments.length) return;
    this.host.followOutput = true;
    this.host.composerInput.value = '';
    this.host.composerInput.style.height = 'auto';
    this.host.hidePopup();
    const attachments = this.host.attachments.slice();
    this.host.attachments = [];
    this.renderAttachRow();
    this.host.updateSendAffordance();
    this.host.post({ kind: 'send', content: text, attachments: attachments.length ? attachments : undefined });
    // 乐观渲染统一由 controller 的 optimistic-user 承担（受理后即时显示，防双份）
  }
}

