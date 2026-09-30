/**
 * [INPUT]: 消费 ./render 的 h()/isTodoWrite()、./events 的 MutableSessionMessage、./i18n 的 Translate
 * [OUTPUT]: 对外提供 extractLatestTodos()（消息集 → 最近任务清单推导）与 renderTodoPanel()（进程面板渲染）与 TodoPanelItem 形状
 * [POS]: webview 的进程面板层——消息流与 composer 之间的常驻任务进展（对标桌面端"进程"状态面板）；不持有状态，chat.ts 在消息集变化时调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { h, isTodoWrite } from './render';
import type { MutableSessionMessage } from './events';
import type { Translate } from './i18n';

/** 面板消费的任务项（TodoWrite input.todos 的宽容收窄） */
export interface TodoPanelItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * 反向扫描消息集取最近一次 TodoWrite 的 todos（无则 null）。
 * 不持有副本：每次消息集变化重新推导——流式 input 到达、refresh-messages 校准、
 * 会话恢复/清空四条路径共用同一推导，无需单独维护状态生命周期。
 */
export function extractLatestTodos(messages: Map<string, MutableSessionMessage>): TodoPanelItem[] | null {
  for (const m of [...messages.values()].reverse()) {
    for (const p of [...m.parts].reverse()) {
      if (p.type !== 'tool') continue;
      const tool = (p as { tool?: string }).tool ?? '';
      const input = (p as { state?: { input?: unknown } }).state?.input as { todos?: unknown } | undefined;
      // 名字命中但 input 未到（tool.updated 不带 input，待 refresh-messages 回填）：
      // 跳过该部件沿用上一次已知清单，而非误判为"无任务"
      if (!isTodoWrite(tool, input) || !Array.isArray(input?.todos)) continue;
      const todos = input.todos
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
        .map((x) => ({
          content: typeof x.content === 'string' ? x.content : '',
          status: x.status === 'completed' ? 'completed' as const : x.status === 'in_progress' ? 'in_progress' as const : 'pending' as const
        }));
      return todos.length ? todos : null;
    }
  }
  return null;
}

/**
 * 渲染进程面板（幂等重建；展开态从旧节点的 .open 类读取，重建间保留）。
 * 头行 = 状态点 + 标题 + 计数 + 当前任务（单行省略）+ chevron；展开追加完整清单（复用 .todo-item 三态样式）。
 */
export function renderTodoPanel(el: HTMLElement, todos: TodoPanelItem[] | null, t: Translate): void {
  const wasOpen = el.classList.contains('open');
  el.innerHTML = '';
  el.classList.remove('open');
  if (!todos || !todos.length) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');

  const done = todos.filter((x) => x.status === 'completed').length;
  const allDone = done === todos.length;
  const current = todos.find((x) => x.status === 'in_progress');
  const dot = allDone ? 'todo-dot-completed' : current ? 'todo-dot-running' : 'todo-dot-pending';

  const head = h('div', { class: 'todo-panel-head' },
    h('span', { class: `todo-dot ${dot}` }, allDone ? '✓' : ''),
    h('span', { class: 'todo-panel-title' }, t('progressPanel')),
    h('span', { class: 'todo-panel-count' }, `${done}/${todos.length}`),
    h('span', { class: 'todo-panel-current' }, allDone ? t('todoAllDone') : current?.content ?? ''),
    h('span', { class: 'todo-panel-chevron' }, wasOpen ? '▾' : '▸')
  );
  head.addEventListener('click', () => {
    const open = el.classList.toggle('open');
    const chevron = el.querySelector('.todo-panel-chevron');
    if (chevron) chevron.textContent = open ? '▾' : '▸';
  });
  el.append(head);

  if (wasOpen) {
    el.classList.add('open');
    const list = h('div', { class: 'todo-panel-list' });
    for (const td of todos) {
      const st = td.status === 'completed' ? 'completed' : td.status === 'in_progress' ? 'running' : 'pending';
      list.append(h('div', { class: `todo-item todo-${st}` },
        h('span', { class: `todo-dot todo-dot-${st}` }, st === 'completed' ? '✓' : ''),
        h('span', { class: 'todo-text' }, td.content)));
    }
    el.append(list);
  }
}
