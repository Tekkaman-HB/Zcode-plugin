/**
 * [INPUT]: 消费 ../protocol/types 的消息部件类型、./markdown、./i18n
 * [OUTPUT]: 对外提供 h()/esc()/jsonBlock()/diffBlock()/htmlFragment()/isAskUserQuestion()/isTodoWrite() 工具与 renderMessage/renderPart 等部件渲染器（含 AskUserQuestion 问答摘要卡与 TodoWrite 任务清单卡——默认折叠，清单由 ./todoPanel 进程面板常驻展示）
 * [POS]: webview 的渲染层——纯函数式 DOM 构建，chat.ts 持有状态并调用；交互卡片见 ./interaction
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type {
  SessionMessage,
  MessagePart,
  ToolPart,
  TextPart,
  ReasoningPart,
  FilePart,
  CompactionPart,
  TimelinePart
} from '../../protocol/types';
import { renderMarkdown } from './markdown';
import type { Translate } from './i18n';

// ═══════════════ DOM 工具 ═══════════════

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') {
      el.addEventListener(k.replace(/^on/, ''), v as EventListener);
    } else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
    } else if (k === 'class') {
      el.className = v;
    } else {
      el.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c == null) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

export function relTime(ts: number, t: Translate): string {
  const diff = Date.now() - ts;
  const min = 60_000, hour = 3_600_000, day = 86_400_000;
  if (diff < min) return t('idle'); // 近期：不精确显示
  if (diff < hour) return `${Math.floor(diff / min)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  return `${Math.floor(diff / day)}d`;
}

export function jsonBlock(value: unknown): HTMLElement {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (text && text.startsWith('"')) text = JSON.parse(text) as string; // 已 JSON 字符串化的内容
  } catch {
    text = String(value);
  }
  if (text === undefined || text === 'undefined') text = '';
  return h('pre', { class: 'json-block' }, text.length > 8000 ? text.slice(0, 8000) + '\n… (truncated)' : text);
}

/** AskUserQuestion 工具判定（工具卡渲染与权限卡 permPreview 分流共用的唯一事实源） */
export function isAskUserQuestion(toolName: string, input: unknown): boolean {
  if (input && typeof input === 'object' && Array.isArray((input as { questions?: unknown }).questions)) return true;
  const token = toolName.trim().toLowerCase().replace(/[\s_]+/g, '');
  return token.includes('askuserquestion');
}

/** TodoWrite 工具判定：todos 载荷或工具名（todo_write 变体），任务清单卡分流 */
export function isTodoWrite(toolName: string, input: unknown): boolean {
  if (input && typeof input === 'object' && Array.isArray((input as { todos?: unknown }).todos)) return true;
  const token = toolName.trim().toLowerCase().replace(/[\s_]+/g, '');
  return token.includes('todowrite') || token.includes('todoplan');
}

// ═══════════════ 工具卡片 ═══════════════

const TOOL_STATUS_ICON: Record<string, string> = {
  pending: '◌',
  running: '▶',
  completed: '✓',
  error: '✕',
  denied: '⊘'
};

/** 用户手动折叠的 partId 集合：重渲染（流式 delta/回合结束校准）时保持折叠选择，其余一律默认展开 */
const userCollapsed = new Set<string>();

/** 用户手动展开的 partId 集合：TodoWrite 卡默认折叠（清单已由进程面板常驻展示，消息流卡仅留审计），展开选择同样跨重渲染保留 */
const userExpanded = new Set<string>();

/** 会话切换时清空折叠/展开记忆 */
export function resetToolCollapseState(): void {
  userCollapsed.clear();
  userExpanded.clear();
}

export function renderToolPart(part: ToolPart, t: Translate): HTMLElement {
  const st = part.state as { status?: string; output?: string; error?: string; title?: string; input?: unknown };
  const status = st?.status ?? 'pending';
  const summary = st?.title || (typeof st?.input === 'object' && st?.input !== null
    ? summarizeInput(st.input as Record<string, unknown>)
    : String(st?.input ?? '').slice(0, 120));

  const header = h('div', { class: 'tool-card-header' },
    h('span', { class: `tool-status-icon tool-status-${status}` }, TOOL_STATUS_ICON[status] ?? '◌'),
    h('span', { class: 'tool-card-name' }, part.tool),
    h('span', { class: 'tool-card-summary' }, summary)
  );
  /** 摘要替换（AskQ/Write/Edit 分支共用）：span 重建后 textContent 安全赋值 */
  const setSummary = (text: string) => {
    const sp = document.createElement('span');
    sp.className = 'tool-card-summary';
    sp.textContent = text;
    header.querySelector('.tool-card-summary')?.replaceWith(sp);
  };

  const body = h('div', { class: 'tool-card-body' });
  // Edit/MultiEdit：old_string/new_string → diff 行（删红/增绿）；Write：content 全绿（新建文件）
  const input = st?.input as Record<string, unknown> | undefined;
  // AskUserQuestion：问题→答案 摘要（对标桌面端 ask-question 渲染器），替代裸 JSON
  const isAskQ = isAskUserQuestion(part.tool, input);
  const isTodo = !isAskQ && isTodoWrite(part.tool, input);
  const isWrite = !isAskQ && !isTodo && /write/i.test(part.tool) && input && typeof input.content === 'string' && !input.new_string;
  if (isTodo) {
    // TodoWrite → 任务清单卡（对标桌面端 todo 渲染）：状态点 + 文案，summary = 完成数/总数
    const todos = (input?.todos ?? []) as { content?: string; status?: string }[];
    const done = todos.filter((x) => x.status === 'completed').length;
    setSummary(`${done}/${todos.length}`);
    if (todos.length) {
      const list = h('div', { class: 'tool-card-section' }, h('div', { class: 'tool-card-label' }, t('todoList')));
      for (const td of todos) {
        const st = td.status === 'completed' ? 'completed' : td.status === 'in_progress' ? 'running' : 'pending';
        list.append(h('div', { class: `todo-item todo-${st}` },
          h('span', { class: `todo-dot todo-dot-${st}` }, st === 'completed' ? '✓' : ''),
          h('span', { class: 'todo-text' }, td.content ?? '')));
      }
      body.append(list);
    }
  } else if (isAskQ) {
    const qs = (input?.questions ?? []) as { question: string; header?: string }[];
    const answers = (input?.answers ?? {}) as Record<string, string | string[]>;
    if (qs[0]?.header) setSummary(qs[0].header);
    else if (qs.length) setSummary(`${qs.length} Q`);
    for (const q of qs) {
      const a = answers[q.question];
      const text = Array.isArray(a) ? a.join(', ') : typeof a === 'string' ? a : '';
      body.append(h('div', { class: 'qa-item' },
        h('div', { class: 'qa-q' }, q.question),
        h('div', { class: 'qa-a' }, text || t('noAnswerProvided'))));
    }
    if (!qs.length) body.append(h('div', { class: 'qa-item' }, h('div', { class: 'qa-a' }, t('noAnswerProvided'))));
  } else if (isWrite) {
    const file = typeof input.file_path === 'string' ? input.file_path.split('/').pop() : undefined;
    if (file) setSummary(file);
    body.append(h('div', { class: 'tool-card-section' }, h('div', { class: 'tool-card-label' }, 'new file'),
      h('pre', { class: 'json-block diff-add' }, String(input.content))));
  } else if (input && typeof input.new_string === 'string') {
    const file = typeof input.file_path === 'string' ? input.file_path.split('/').pop() : undefined;
    if (file) setSummary(file);
    if (typeof input.old_string === 'string') {
      body.append(h('div', { class: 'tool-card-section' }, h('div', { class: 'tool-card-label' }, 'diff'),
        diffBlock(String(input.old_string), String(input.new_string))));
    } else {
      body.append(h('div', { class: 'tool-card-section' }, h('div', { class: 'tool-card-label' }, 'new'),
        h('pre', { class: 'json-block diff-add' }, input.new_string)));
    }
  } else {
    if (st?.input !== undefined && st?.input !== null && status !== 'pending') {
      body.append(h('div', { class: 'tool-card-section' }, h('div', { class: 'tool-card-label' }, t('toolInput')), jsonBlock(st.input)));
    }
  }
  if (!isAskQ && !isTodo && status === 'completed' && st?.output) {
    body.append(h('div', { class: 'tool-card-section' }, h('div', { class: 'tool-card-label' }, t('toolOutput')), jsonBlock(st.output)));
  }
  if (status === 'error' && st?.error) {
    body.append(h('div', { class: 'tool-card-section error' }, h('div', { class: 'tool-card-label' }, t('error')), jsonBlock(st.error)));
  }

  const card = h('div', { class: `tool-card tool-card-${status}`, 'data-part-id': part.partId },
    header,
    body.children.length ? body : null
  );
  if (body.children.length) {
    // 折叠状态由 .collapsed 类驱动（body 默认显示）；默认一律展开（Bash/Edit 内容直接可见），
    // 仅用户手动折叠过的 partId 保持折叠——流式重渲染不会弹开用户的选择；
    // 例外：TodoWrite 卡默认折叠（进程面板常驻展示清单），用户展开过则保持展开
    const startCollapsed = isTodo ? !userExpanded.has(part.partId) : userCollapsed.has(part.partId);
    const chevron = h('span', { class: 'tool-chevron' }, startCollapsed ? '▸' : '▾');
    header.append(chevron);
    (header as HTMLElement).addEventListener('click', () => {
      if (isTodo) {
        if (userExpanded.has(part.partId)) {
          userExpanded.delete(part.partId);
          card.classList.add('collapsed');
          chevron.textContent = '▸';
        } else {
          userExpanded.add(part.partId);
          card.classList.remove('collapsed');
          chevron.textContent = '▾';
        }
      } else if (userCollapsed.has(part.partId)) {
        userCollapsed.delete(part.partId);
        card.classList.remove('collapsed');
        chevron.textContent = '▾';
      } else {
        userCollapsed.add(part.partId);
        card.classList.add('collapsed');
        chevron.textContent = '▸';
      }
    });
    if (startCollapsed) {
      card.classList.add('collapsed');
    }
  }
  return card;
}

/**
 * Edit 工具的 diff 视图：old_string 全行标红（删除），new_string 全行标绿（新增）。
 * 简易 LCS 会更精确，但对单文件编辑场景"整块旧删/整块新增"已足够还原语义。
 */
export function diffBlock(oldStr: string, newStr: string): HTMLElement {
  const wrap = h('div', { class: 'json-block' });
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  // 公共前缀/后缀对齐：让改动区收拢，上下文不重复染色
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  const addLine = (text: string, cls: string) => {
    const el = h('div', { class: `diff-line ${cls}` }, text.length ? text : ' ');
    wrap.append(el);
  };
  for (const l of oldLines.slice(0, prefix)) addLine(l, 'diff-ctx');
  for (const l of oldMid) addLine('- ' + l, 'diff-del');
  for (const l of newMid) addLine('+ ' + l, 'diff-add');
  for (const l of newLines.slice(newLines.length - suffix)) addLine(l, 'diff-ctx');
  return wrap;
}

function summarizeInput(input: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const v = input[k];
    if (typeof v === 'string' && v) return v.length > 80 ? v.slice(0, 80) + '…' : v;
  }
  const keys = Object.keys(input);
  return keys.length ? `{${keys.slice(0, 4).join(', ')}}` : '';
}

// ═══════════════ 消息 ═══════════════

export function renderMessage(msg: SessionMessage, t: Translate, onAttachment?: (name: string, url?: string, isImg?: boolean) => void): HTMLElement {
  const role = msg.info?.role ?? 'assistant';
  const el = h('div', { class: `msg msg-${role}`, 'data-message-id': String(msg.info?.messageId ?? '') });

  if (role === 'user') {
    const el2 = h('div', { class: 'msg-user-block' });
    for (const p of msg.parts) {
      if (p.type === 'text') {
        const tp = p as unknown as TextPart;
        if (!tp.ignored) el2.append(h('div', { class: 'msg-user-text' }, tp.text));
      } else if (p.type === 'file') {
        const fp = p as unknown as FilePart;
        const name = fp.filename ?? fp.url;
        const isImg = /^image\//.test(fp.mime ?? '') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
        const chip = h('button', {
          class: `msg-attachment msg-attachment-btn${isImg ? ' msg-attachment-img' : ''}`,
          title: name
        });
        if (isImg) {
          // 图片附件：缩略图 + 文件名（预览数据由 chat 层的 registry 提供）
          const img = h('img', { class: 'msg-attach-thumb', alt: name });
          if (/^(data:|https?:)/.test(fp.url ?? '')) img.src = fp.url!;
          chip.append(img, h('span', { class: 'attach-chip-name' }, name));
        } else {
          chip.textContent = name;
        }
        if (onAttachment) {
          (chip as HTMLElement).addEventListener('click', () => onAttachment(name, fp.url, isImg));
        }
        el2.append(chip);
      }
    }
    el.append(el2);
    return el;
  }

  // assistant / system：按部件顺序渲染
  let hasContent = false;
  for (const p of msg.parts) {
    const node = renderPart(p, t);
    if (node) {
      el.append(node);
      hasContent = true;
    }
  }
  if (!hasContent) el.append(h('div', { class: 'msg-thinking' }, `✳ ${t('thinking')}`));
  return el;
}

export function renderPart(p: MessagePart, t: Translate): HTMLElement | null {
  // UnknownPart 带 string 索引签名，联合不可判别；按 case 显式收窄
  switch (p.type) {
    case 'text': {
      const tp = p as unknown as import('../../protocol/types').TextPart;
      if (tp.ignored || !tp.text) return null;
      return h('div', { class: 'md', 'data-part-id': tp.partId }, htmlNode(renderMarkdown(tp.text)));
    }
    case 'reasoning': {
      const rp = p as unknown as ReasoningPart;
      if (!rp.text) return null;
      return h('details', { class: 'reasoning', 'data-part-id': rp.partId },
        h('summary', {}, `✻ ${t('thinking')}`),
        h('div', { class: 'md reasoning-body' }, htmlNode(renderMarkdown(rp.text)))
      );
    }
    case 'tool':
      return renderToolPart(p as unknown as ToolPart, t);
    case 'step-start':
    case 'step-finish':
      return h('div', { class: 'step-marker' });
    case 'compaction': {
      const cp = p as unknown as CompactionPart;
      return h('div', { class: 'compaction-note' }, `⤵ ${cp.reason ?? 'context compacted'}`);
    }
    case 'file': {
      const fp = p as unknown as import('../../protocol/types').FilePart;
      return h('button', { class: 'msg-attachment msg-attachment-btn', title: fp.filename ?? fp.url }, fp.filename ?? fp.url);
    }
    case 'timeline': {
      const tp = p as unknown as TimelinePart;
      return h('div', { class: 'timeline-note' }, `— ${tp.timelineType} —`);
    }
    default:
      return null; // snapshot/patch 等内部部件不渲染
  }
}

function htmlNode(html: string): Node {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
}

/** markdown HTML → DocumentFragment（交互卡 preview 消费） */
export function htmlFragment(html: string): DocumentFragment {
  return htmlNode(html) as DocumentFragment;
}

// ═══════════════ 会话列表（sessions 视图） ═══════════════

export function renderSessionItem(
  s: { sessionId: string; title: string; updatedAt: number; mode: string; status: string },
  t: Translate,
  onResume: () => void
): HTMLElement {
  return h('div', { class: 'session-item', onclick: onResume },
    h('div', { class: 'session-item-title' }, s.title || '(untitled)'),
    h('div', { class: 'session-item-meta' },
      h('span', { class: 'session-item-mode' }, s.mode),
      h('span', {}, relTime(s.updatedAt, t)),
      s.status === 'running' ? h('span', { class: 'session-item-running' }, '●') : null
    )
  );
}
