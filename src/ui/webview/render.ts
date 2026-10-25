/**
 * [INPUT]: 消费 ../../protocol/types、./markdown、./format、./i18n、./icons 与 ./clipboard；流式活性由 chat.ts 传入
 * [OUTPUT]: DOM/消息/部件/diff 渲染器；命令状态与真实输入摘要、流式工具输出、工具折叠记忆、消息/代码复制与思考反馈
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
import { normalizeToolOutputText } from './format';
import type { Translate } from './i18n';
import { iconEl } from './icons';
import { copyButton } from './clipboard';

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

/** harness 注入给模型的元文本标记——不是给用户看的内容，渲染层整段过滤（数据保留，仅展示过滤） */
export function isSystemReminderText(text: string): boolean {
  return text.includes('<system-reminder>');
}

// ═══════════════ 工具卡片 ═══════════════



/** 用户手动折叠的 partId 集合：重渲染时保持折叠选择；未选择的普通工具默认折叠，错误展开 */
const userCollapsed = new Set<string>();

/** 用户手动展开的 partId 集合：手动展开的工具保持展开，展开选择同样跨重渲染保留 */
const userExpanded = new Set<string>();

/** 会话切换时清空折叠/展开记忆与思考计时锚点 */
export function resetToolCollapseState(): void {
  userCollapsed.clear();
  userExpanded.clear();
  thinkingStarts.clear();
}

/** 思考计时锚点（key → 起始时刻）：占位/推理块节点重建不重置秒表；节点脱离 DOM=锚点清理 */
const thinkingStarts = new Map<string, number>();

/** 旋转环加载器，状态文字与秒表提供持续反馈 */
function pixelGrid(): HTMLElement {
  return h('span', { class: 'think-pixel', 'aria-hidden': 'true' });
}

/** 自清生命周期秒表 span：每秒自增，节点脱离 DOM 即停表并清理锚点（思考占位与流式推理摘要共用） */
function elapsedSecsSpan(key: string): HTMLElement {
  let start = thinkingStarts.get(key);
  if (start === undefined) {
    start = Date.now();
    thinkingStarts.set(key, start);
  }
  const el = h('span', { class: 'think-secs' }, `${Math.floor((Date.now() - start) / 1000)}s`);
  const timer = setInterval(() => {
    if (!el.isConnected) {
      clearInterval(timer);
      thinkingStarts.delete(key);
      return;
    }
    el.textContent = `${Math.floor((Date.now() - start) / 1000)}s`;
  }, 1000);
  return el;
}

/**
 * 思考中占位（旋转环 + 思考文字 + 动态秒表，
 * 点阵动画走 CSS，interval 每秒只刷秒数）；interval 以 isConnected 自判生命周期——
 * 内容到达后占位节点被移除，计时随之停止；下一段思考（新消息）从 0s 重新计
 */
function thinkingPlaceholder(messageId: string, t: Translate): HTMLElement {
  const secs = elapsedSecsSpan(messageId || `anon-${thinkingStarts.size}`);
  return h('div', { class: 'msg-thinking' }, pixelGrid(), h('span', { class: 'think-label' }, t('thinking')), secs);
}

/** 流式推理摘要（同款动效，锚点按 partId 跨重建续秒）：仅用于正在流式消息的尾部推理部件 */
function liveReasoningSummary(partId: string, t: Translate): HTMLElement {
  return h('summary', { class: 'reasoning-live' }, pixelGrid(), h('span', { class: 'think-label' }, t('thinking')), elapsedSecsSpan(`reasoning:${partId}`));
}

export function renderToolPart(part: ToolPart, t: Translate): HTMLElement {
  const st = part.state as { status?: string; output?: string; error?: string; title?: string; input?: unknown };
  const status = st?.status ?? 'pending';
  const isCommand = /bash|exec|command|shell|terminal/i.test(part.tool);
  const input = st?.input && typeof st.input === 'object' ? st.input as Record<string, unknown> : undefined;
  const command = isCommand && typeof input?.command === 'string' ? input.command
    : isCommand && typeof input?.cmd === 'string' ? input.cmd : undefined;
  const summary = command || (st?.title?.trim().toLowerCase() !== part.tool.trim().toLowerCase() ? st?.title : '') || (typeof st?.input === 'object' && st?.input !== null
    ? summarizeInput(st.input as Record<string, unknown>)
    : String(st?.input ?? '').slice(0, 120));
  const stopped = ['interrupted', 'cancelled', 'canceled'].includes(status);
  const label = !isCommand ? part.tool : t(status === 'completed' ? 'commandRan'
    : status === 'error' ? 'commandFailed' : status === 'denied' ? 'commandDenied'
    : stopped ? 'commandStopped' : status === 'pending' ? 'commandPending' : 'commandRunning');

  const toolIcon = status === 'running' || status === 'pending' ? 'spinner'
    : status === 'error' || status === 'denied' ? 'close'
    : stopped ? 'stop'
    : isCommand ? 'terminal'
    : /edit|write|read|file/i.test(part.tool) ? 'file'
    : /search|grep|glob/i.test(part.tool) ? 'search' : 'code';
  const header = h('button', { type: 'button', class: 'tool-card-header' },
    h('span', { class: `tool-status-icon tool-status-${status}`, title: status }, iconEl(toolIcon)),
    h('span', { class: 'tool-card-name' }, label),
    h('span', { class: 'tool-card-summary', title: summary }, summary)
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
          h('span', { class: `todo-dot todo-dot-${st}` }, st === 'completed' ? iconEl('check') : null),
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
  } else if (command) {
    body.append(h('div', { class: 'tool-card-section' }, h('div', { class: 'tool-card-label' }, t('commands')),
      h('pre', { class: 'json-block tool-command' }, command)));
  } else {
    if (st?.input !== undefined && st?.input !== null && status !== 'pending') {
      body.append(h('div', { class: 'tool-card-section' }, h('div', { class: 'tool-card-label' }, t('toolInput')), jsonBlock(st.input)));
    }
  }
  if (!isAskQ && !isTodo && st?.output) {
    // 权威刷新路径的 output 可能是 CLI 序列化拍平的内容块 JSON（换行逃逸成字面 \n）——渲染前还原
    body.append(h('div', { class: 'tool-card-section' }, h('div', { class: 'tool-card-label' }, t('toolOutput')), jsonBlock(normalizeToolOutputText(st.output))));
  }
  if ((status === 'error' || status === 'denied') && st?.error) {
    body.append(h('div', { class: 'tool-card-section error' }, h('div', { class: 'tool-card-label' }, t('error')), jsonBlock(st.error)));
  }

  const card = h('div', { class: `tool-card tool-card-${status}`, 'data-part-id': part.partId },
    header,
    body.children.length ? body : null
  );
  if (body.children.length) {
    // 普通工具以摘要呈现，错误默认展开；手动选择在刷新之间保留。
    const startCollapsed = userCollapsed.has(part.partId) || (!userExpanded.has(part.partId) && status !== 'error' && status !== 'denied');
    const chevron = h('span', { class: 'tool-chevron' }, iconEl('chevronDown'));
    header.setAttribute('aria-expanded', String(!startCollapsed));
    header.append(chevron);
    header.addEventListener('click', () => {
      const collapsed = card.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', String(!collapsed));
      if (collapsed) { userCollapsed.add(part.partId); userExpanded.delete(part.partId); }
      else { userExpanded.add(part.partId); userCollapsed.delete(part.partId); }
    });
    if (startCollapsed) {
      card.classList.add('collapsed');
    }
  } else header.disabled = true;
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

export function renderMessage(msg: SessionMessage, t: Translate, onAttachment?: (name: string, url?: string, isImg?: boolean) => void, opts?: { live?: boolean }): HTMLElement | null {
  const role = msg.info?.role ?? 'assistant';
  const el = h('div', { class: `msg msg-${role}`, 'data-message-id': String(msg.info?.messageId ?? '') });

  if (role === 'user') {
    // 服务端 model-only 注入（todo 提醒/后台任务等）：只给模型看，整条不渲染——
    // 这类提醒不带 <system-reminder> 标签（resume/messages 两方言均带 info.visibility，探针实证），文本过滤兜不住
    if ((msg.info as { visibility?: unknown } | undefined)?.visibility === 'model-only') return null;
    const el2 = h('div', { class: 'msg-user-block' });
    for (const p of msg.parts) {
      if (p.type === 'text') {
        const tp = p as unknown as TextPart;
        if (!tp.ignored && !isSystemReminderText(tp.text ?? '')) el2.append(h('div', { class: 'msg-user-text' }, tp.text));
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
    if (!el2.children.length) return null; // 整条被过滤（如 system-reminder）→ 不渲染空壳
    el.append(el2, h('div', { class: 'message-actions' }, copyButton(() =>
      [...el2.querySelectorAll('.msg-user-text')].map(n => n.textContent ?? '').join('\n'), t)));
    return el;
  }

  // assistant / system：按部件顺序渲染；尾部件继承消息的流式活性（推理块据此切换动态/存档摘要）
  let hasContent = false;
  for (let i = 0; i < msg.parts.length; i++) {
    const node = renderPart(msg.parts[i], t, Boolean(opts?.live) && i === msg.parts.length - 1);
    if (node) {
      el.append(node);
      hasContent = true;
    }
  }
  if (!hasContent) {
    // parts 为空 = 流式起步的空消息 → 保留"思考中"占位；
    // parts 非空但全部被过滤（system-reminder/ignored）→ 整条不渲染
    if (msg.parts.length === 0) el.append(thinkingPlaceholder(String(msg.info?.messageId ?? ''), t));
    else return null;
  }
  if (hasContent && !opts?.live && msg.parts.some(p => p.type === 'text' && !(p as TextPart).ignored)) {
    el.append(h('div', { class: 'message-actions' }, copyButton(() => msg.parts
      .filter(p => p.type === 'text' && !(p as TextPart).ignored && !isSystemReminderText((p as TextPart).text))
      .map(p => (p as TextPart).text).join('\n\n'), t)));
  }
  return el;
}

export function renderPart(p: MessagePart, t: Translate, tailLive = false): HTMLElement | null {
  // UnknownPart 带 string 索引签名，联合不可判别；按 case 显式收窄
  switch (p.type) {
    case 'text': {
      const tp = p as unknown as import('../../protocol/types').TextPart;
      if (tp.ignored || !tp.text || isSystemReminderText(tp.text)) return null;
      return h('div', { class: 'md', 'data-part-id': tp.partId }, markdownNode(tp.text, t));
    }
    case 'reasoning': {
      const rp = p as unknown as ReasoningPart;
      if (!rp.text) return null;
      // 流式消息的尾部推理部件=正在思考 → 动态摘要（旋转环+思考中+秒表）；
      // 后面出现输出部件或消息已落档 → 定格为"✻ 思考过程 ▸"存档态。
      // 摘要必须是 <summary> 元素：details 首子元素非 summary 时浏览器会渲染默认"详情"
      const summary = tailLive
        ? liveReasoningSummary(rp.partId ?? '', t)
        : h('summary', {}, t('thoughtProcess'), h('span', { class: 'reasoning-chevron icon-svg' }, iconEl('chevronRight')));
      return h('details', { class: 'reasoning', 'data-part-id': rp.partId },
        summary,
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

/** 代码块头部提供语言与复制；正文仍由同一 Markdown 渲染器负责。 */
function markdownNode(text: string, t: Translate): DocumentFragment {
  const fragment = htmlFragment(renderMarkdown(text));
  fragment.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    const language = code?.className.match(/language-([\w+-]+)/)?.[1] ?? '';
    const wrap = h('div', { class: 'code-block' });
    pre.replaceWith(wrap);
    wrap.append(h('div', { class: 'code-header' }, h('span', {}, language),
      copyButton(() => code?.textContent ?? pre.textContent ?? '', t)), pre);
  });
  return fragment;
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
