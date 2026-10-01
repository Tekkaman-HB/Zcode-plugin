/**
 * [INPUT]: 消费 ./render 的 h()/isTodoWrite()、./events 的 MutableSessionMessage、./i18n 的 Translate
 * [OUTPUT]: 对外提供 extractLatestTodos()（消息集 → 最近 TodoWrite 推导，含任务身份 callId）、renderTodoPanel()（进程面板渲染：点击头行立即重建；全部完成时头行渲染关闭按钮，onClose(callId) 上报）与关闭记忆持久化 loadClosedTodoCallIds/saveClosedTodoCallIds 及 TodoPanelInfo/TodoPanelItem 形状
 * [POS]: webview 的进程面板层——消息流与 composer 之间的常驻任务进展（对标桌面端"进程"状态面板）；不持有渲染状态，chat.ts 在消息集变化时调用；关闭记忆经 localStorage 持久化（跨会话切换/webview 重载保留）
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

/** 最近一次 TodoWrite 的推导结果：callId 是任务身份（关闭记忆按它记，新一轮任务自动重现） */
export interface TodoPanelInfo {
  todos: TodoPanelItem[];
  callId: string;
}

/**
 * 反向扫描消息集取最近一次 TodoWrite（无则 null）。
 * 不持有副本：每次消息集变化重新推导——流式 input 到达、refresh-messages 校准、
 * 会话恢复/清空四条路径共用同一推导，无需单独维护状态生命周期。
 * 遇到更新的 TodoWrite 调用即停：input 已回填→返回它；未回填（tool.updated 不带 input，
 * refresh-messages 回来前的窗口）→返回 null 面板暂隐——绝不回显更早的旧任务
 * （否则新任务开始后旧任务一直占位）。
 */
export function extractLatestTodos(messages: Map<string, MutableSessionMessage>): TodoPanelInfo | null {
  for (const m of [...messages.values()].reverse()) {
    for (const p of [...m.parts].reverse()) {
      if (p.type !== 'tool') continue;
      const tool = (p as { tool?: string }).tool ?? '';
      const input = (p as { state?: { input?: unknown } }).state?.input as { todos?: unknown } | undefined;
      if (!isTodoWrite(tool, input)) continue;
      if (!Array.isArray(input?.todos)) return null; // 更新的调用已出现但清单未到：暂隐等待，不回显旧任务
      const todos = input.todos
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
        .map((x) => ({
          content: typeof x.content === 'string' ? x.content : '',
          status: x.status === 'completed' ? 'completed' as const : x.status === 'in_progress' ? 'in_progress' as const : 'pending' as const
        }));
      if (!todos.length) return null;
      return { todos, callId: (p as { callId?: string }).callId ?? '' };
    }
  }
  return null;
}

/** 关闭记忆的 localStorage 键与容量上限（插入序保留最新 50 条，防无限增长） */
const TODO_CLOSED_KEY = 'zcode.todoClosedCallIds';
const TODO_CLOSED_CAP = 50;

/** 读取关闭记忆（损坏/隐私模式降级为空集：面板照常显示，只是本次关闭不入库） */
export function loadClosedTodoCallIds(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(TODO_CLOSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** 写入关闭记忆（Set 插入序=时间序，截尾保留最新） */
export function saveClosedTodoCallIds(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(TODO_CLOSED_KEY, JSON.stringify([...ids].slice(-TODO_CLOSED_CAP)));
  } catch { /* 配额满/隐私模式静默：关闭记忆退化为本次 webview 会话内 */ }
}

/**
 * 渲染进程面板（幂等重建；展开态从旧节点的 .open 类读取，重建间保留）。
 * 头行 = 状态点 + 标题 + 计数 + 当前任务（单行省略）+ [全部完成时的关闭按钮] + chevron；
 * 展开追加完整清单（复用 .todo-item 三态样式）。
 * 关闭语义：info.callId ∈ closedCallIds 时隐藏——仅被手动关过的任务隐藏（持久化，跨会话/重载），
 * 新一轮 TodoWrite（新 callId）重现。
 */
export function renderTodoPanel(
  el: HTMLElement,
  info: TodoPanelInfo | null,
  closedCallIds: ReadonlySet<string>,
  t: Translate,
  onClose: (callId: string) => void
): void {
  const wasOpen = el.classList.contains('open');
  el.innerHTML = '';
  el.classList.remove('open');
  if (!info || !info.todos.length || closedCallIds.has(info.callId)) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');

  const todos = info.todos;
  const done = todos.filter((x) => x.status === 'completed').length;
  const allDone = done === todos.length;
  const current = todos.find((x) => x.status === 'in_progress');
  const dot = allDone ? 'todo-dot-completed' : current ? 'todo-dot-running' : 'todo-dot-pending';

  const head = h('div', { class: 'todo-panel-head' },
    h('span', { class: `todo-dot ${dot}` }, allDone ? '✓' : ''),
    h('span', { class: 'todo-panel-title' }, t('progressPanel')),
    h('span', { class: 'todo-panel-count' }, `${done}/${todos.length}`),
    h('span', { class: 'todo-panel-current' }, allDone ? t('todoAllDone') : current?.content ?? '')
  );
  // 关闭按钮：仅全部完成时出现（未完成的任务没有可关性）；点击不冒泡（不触发展开/折叠）
  if (allDone) {
    const closeBtn = h('button', { class: 'todo-panel-close', title: t('todoClose') }, '×');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClose(info.callId);
    });
    head.append(closeBtn);
  }
  head.append(h('span', { class: 'todo-panel-chevron' }, wasOpen ? '▾' : '▸'));
  head.addEventListener('click', () => {
    // 翻转意图后立即重建：清单 DOM 只由 renderTodoPanel 落地——只 toggle class 不重建，
    // 点击会"看似无反应"（class 延迟到下次消息刷新才体现=自动打开/折叠不上的根因）
    el.classList.toggle('open');
    renderTodoPanel(el, info, closedCallIds, t, onClose);
  });
  el.append(head);

  if (wasOpen) {
    // 对标桌面端 todo 卡：清单在上、把手行在下（CSS 用 .open 给 head 加分隔线）
    el.classList.add('open');
    const list = h('div', { class: 'todo-panel-list' });
    for (const td of todos) {
      const st = td.status === 'completed' ? 'completed' : td.status === 'in_progress' ? 'running' : 'pending';
      list.append(h('div', { class: `todo-item todo-${st}` },
        h('span', { class: `todo-dot todo-dot-${st}` }, st === 'completed' ? '✓' : ''),
        h('span', { class: 'todo-text' }, td.content)));
    }
    el.insertBefore(list, head);
  }
}
