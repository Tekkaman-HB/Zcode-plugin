/**
 * [INPUT]: 依赖浏览器剪贴板/DOM API、./icons 与 ./i18n
 * [OUTPUT]: 对外提供 copyText 和 copyButton，为消息、代码块、聊天菜单提供一致的复制反馈
 * [POS]: webview 的展示操作工具；不经过协议、不记录复制内容
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { iconEl } from './icons';
import type { Translate } from './i18n';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const focused = document.activeElement as HTMLElement | null;
    const field = document.createElement('textarea');
    field.value = text;
    field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* 返回失败，让按钮反馈 */ }
    field.remove();
    focused?.focus();
    return copied;
  }
}

export function copyButton(text: () => string, t: Translate): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-btn';
  button.title = t('copy');
  button.setAttribute('aria-label', t('copy'));
  button.append(iconEl('copy'));
  button.addEventListener('click', async () => {
    const copied = await copyText(text());
    const label = t(copied ? 'copied' : 'copyFailed');
    button.replaceChildren(iconEl(copied ? 'check' : 'copy'));
    button.title = label;
    button.setAttribute('aria-label', label);
    setTimeout(() => {
      button.replaceChildren(iconEl('copy'));
      button.title = t('copy');
      button.setAttribute('aria-label', t('copy'));
    }, 1600);
  });
  return button;
}
