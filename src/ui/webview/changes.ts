/**
 * [INPUT]: ../bridge 的 SessionChangesPayload、./render 和 ./i18n
 * [OUTPUT]: renderChangeSummary，当前会话的文件数/行数与审查入口；无可审查记录时隐藏，部分记录标注范围
 * [POS]: webview 的底部会话差异摘要；只接收宿主已归属的记录，不从工作区推断变更
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { SessionChangesPayload } from '../bridge';
import { h, processingLabel } from './render';
import type { Translate } from './i18n';

export function renderChangeSummary(root: HTMLElement, data: SessionChangesPayload, t: Translate): void {
  const context = root.querySelector('.composer-context');
  const summary = root.querySelector<HTMLElement>('.changes-summary');
  if (!context || !summary) return;
  const visible = data.files > 0 || data.status === 'preparing';
  context.classList.toggle('has-changes', visible);
  summary.classList.toggle('hidden', !visible);
  const stats = summary.querySelector('.changes-stats');
  const review = summary.querySelector<HTMLButtonElement>('.changes-review');
  if (review) review.disabled = !data.files;
  if (!visible) {
    stats?.replaceChildren();
    summary.removeAttribute('title');
    summary.removeAttribute('aria-label');
    return;
  }
  if (data.files) {
    stats?.replaceChildren(h('span', { class: 'changes-count' }, t('filesChanged', { count: String(data.files) })),
      h('span', { class: 'changes-added' }, `+${data.added}`), h('span', { class: 'changes-deleted' }, `−${data.deleted}`),
      ...(data.status === 'partial' ? [h('span', { class: 'changes-note' }, t('sessionChangesPartialLabel'))] : []));
  } else stats?.replaceChildren(processingLabel(t('sessionChangesPreparing'), 'changes-note'));
  summary.title = t(data.status === 'preparing' ? 'sessionChangesPreparing' : data.status === 'partial' ? 'sessionChangesPartial'
    : data.binary ? 'sessionChangesBinary' : 'sessionChanges');
  summary.setAttribute('aria-label', `${summary.title}: ${stats?.textContent ?? ''}`);
}
