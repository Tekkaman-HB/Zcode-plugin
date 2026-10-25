/**
 * [INPUT]: DOM API；品牌图片由 chatProvider 的 body[data-logo] 注入
 * [OUTPUT]: iconEl、MODE_ICONS 与模式/品牌/操作图标工厂，操作图标使用 24px 网格，盾牌叹号复用 Codex 的 20px 原始路径，均继承 currentColor
 * [POS]: webview 图标唯一入口，供导航、输入区、菜单和工具卡共用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const PATHS = {
  back: '<path d="m14 6-6 6 6 6M8 12h12"/>',
  arrowUp: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14m-6-6 6 6 6-6"/>',
  arrowRight: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  chevronDown: '<path d="m7 10 5 5 5-5"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  history: '<path d="M3 10a9 9 0 1 1 1.5 7M3 4v6h6M12 7v5l3 2"/>',
  compose: '<path d="M12 4H6a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-6M14 5l5 5M10 14l1-5L18 2a2 2 0 0 1 3 3l-7 7-4 2Z"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
  settings: '<path d="m9.5 3-.6 2-1.5.9-2-.5L3 9.6 4.4 11v2L3 14.4l2.4 4.2 2-.5 1.5.9.6 2h5l.6-2 1.5-.9 2 .5 2.4-4.2-1.4-1.4v-2L21 9.6l-2.4-4.2-2 .5-1.5-.9-.6-2h-5Z"/><circle cx="12" cy="12" r="3"/>',
  shield: '<path d="M9.06543 1.95123C9.66107 1.69076 10.3389 1.69071 10.9346 1.95123L15.9346 4.13873C16.7832 4.51008 17.3311 5.34917 17.3311 6.27545V10.5528C17.3309 14.6017 14.0489 17.8847 10 17.8848C5.95108 17.8846 2.66813 14.6017 2.66797 10.5528V6.27545C2.66797 5.34924 3.21695 4.51012 4.06543 4.13873L9.06543 1.95123ZM10.4014 3.16998C10.1456 3.05814 9.85444 3.05819 9.59863 3.16998L4.59863 5.35748C4.23427 5.51708 3.99805 5.87764 3.99805 6.27545V10.5528C3.99821 13.8671 6.68563 16.5546 10 16.5547C13.3144 16.5546 16.0008 13.8671 16.001 10.5528V6.27545C16.001 5.87756 15.7658 5.51703 15.4014 5.35748L10.4014 3.16998Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" stroke="none"/><path d="M10.8883 13.1116C10.8883 13.6025 10.4903 14.0005 9.99936 14.0005C9.50844 14.0005 9.11047 13.6025 9.11047 13.1116C9.11047 12.6207 9.50844 12.2227 9.99936 12.2227C10.4903 12.2227 10.8883 12.6207 10.8883 13.1116Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" stroke="none"/><path d="M10.5169 10.8949L11.1135 7.31519C11.2283 6.62672 10.6974 6 9.99941 6C9.30145 6 8.77053 6.62672 8.88528 7.31519L9.4819 10.8949C9.52406 11.1479 9.74294 11.3333 9.99941 11.3333C10.2559 11.3333 10.4748 11.1479 10.5169 10.8949Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" stroke="none"/>',
  plan: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6m-6 4h6m-6 4h4"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14l-1 7Z"/>',
  bolt: '<path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  terminal: '<path d="m5 6 6 6-6 6m8 0h6"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="3"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v7c0 4 6 3 6-3a10 10 0 1 0-4 8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  spinner: '<path d="M21 12a9 9 0 1 1-9-9"/>'
} as const;
export type IconName = keyof typeof PATHS;

/** 装饰图标；可访问名称由外层按钮提供。 */
function svg(name: IconName): string {
  return `<svg viewBox="0 0 ${name === 'shield' ? 20 : 24} ${name === 'shield' ? 20 : 24}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}
export function iconEl(name: IconName): HTMLElement {
  const el = document.createElement('span');
  el.className = `icon-svg icon-${name}`;
  el.innerHTML = svg(name);
  return el;
}
export const MODE_ICONS: Record<string, string> = {
  plan: svg('plan'), build: svg('shield'), edit: svg('edit'), yolo: svg('bolt')
};
/** 品牌标识保留，操作图标与产品身份分开。 */
export function zLogoEl(): HTMLElement {
  const uri = document.body.dataset.logo;
  if (uri) {
    const img = document.createElement('img');
    img.className = 'z-logo';
    img.alt = 'ZCode';
    img.draggable = false;
    img.src = uri;
    return img;
  }
  const el = document.createElement('span');
  el.className = 'z-logo-fallback';
  el.setAttribute('aria-label', 'ZCode');
  el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14L5 19h14" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>';
  return el;
}
export const atIconEl = () => iconEl('at');
export const gearIconEl = () => iconEl('settings');
export const plusIconEl = () => iconEl('plus');
export const clockIconEl = () => iconEl('history');
export const phoneIconEl = () => iconEl('phone');
