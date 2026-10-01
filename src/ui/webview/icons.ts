/**
 * [INPUT]: 无依赖（仅 DOM API）
 * [OUTPUT]: 对外提供 MODE_ICONS 图标表与 zLogoEl/modeIconEl/atIconEl/gearIconEl/plusIconEl/clockIconEl 图标元素工厂
 * [POS]: webview 的内联 SVG 图标层，chat.ts（chip/标题栏/欢迎页）与 menus.ts（模式菜单）消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/** 模式图标（chip 与菜单共用，随 currentColor 着色） */
export const MODE_ICONS: Record<string, string> = {
  plan: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="3" y="2.5" width="10" height="11" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  build: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M5.5 9.5 3 12l-1 2 2-1 2.5-2.5M9 3.5a2.5 2.5 0 0 1 3.5 3.5L8 11.5 5.5 9 11 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  edit: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M9.5 3.5l3 3L6 13H3v-3l6.5-6.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  yolo: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8.5 2 4 9h3.5L7 14l4.5-7H8l.5-5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
};

/** 官方 Z 标（像素级对齐桌面端 icon.png：连续对角带 + 横杠两端斜切段，缝隙即底色） */
export function zLogoEl(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-svg';
  span.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><g fill="#fff"><polygon points="17.8,6.9 13.3,6.9 6.0,17.0 10.5,17.0"/><polygon points="6.4,6.9 12.0,6.9 10.9,8.4 6.4,8.4"/><polygon points="12.9,15.6 17.5,15.6 17.5,17.0 11.8,17.0"/></g></svg>';
  return span;
}

/** 模式图标元素（chip 与菜单共用） */
export function modeIconEl(mode: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-svg';
  span.innerHTML = MODE_ICONS[mode] ?? MODE_ICONS.build;
  return span;
}

/** @ 引用图标 */
export function atIconEl(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-svg';
  span.style.fontWeight = '600';
  span.textContent = '@';
  span.style.fontSize = '12px';
  return span;
}

/** 齿轮图标（配置收纳入口） */
export function gearIconEl(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-svg';
  span.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  return span;
}

/** 新建会话图标（内联 SVG） */
export function plusIconEl(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-svg';
  span.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  return span;
}

/** 头部时钟图标（内联 SVG，随 currentColor 主题着色） */
export function clockIconEl(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-svg';
  span.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6V8l2.3 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  return span;
}
