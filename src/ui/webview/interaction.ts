/**
 * [INPUT]: 依赖 ../../protocol/types 的 PermissionRequestParams/UserInputRequestParams，./render 的 h()/jsonBlock()/htmlFragment()，./permPreview 的工具身份预览，./markdown，./i18n
 * [OUTPUT]: 对外提供 InteractionDraft 草稿类型与 renderPermissionCard()/renderUserInputCard() 交互焦点卡渲染器
 * [POS]: webview 交互层——权限卡（选项排序/分类/键盘导航/问题向导/拒绝反馈/规则前缀）与用户输入卡（单题向导/自定义回答/preview），由 chat.ts 的交互焦点队列驱动；预览分流见 ./permPreview
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type {
  PermissionRequestParams,
  PermissionOption,
  UserInputRequestParams,
  UserInputQuestion
} from '../../protocol/types';
import { h, jsonBlock, htmlFragment } from './render';
import { renderMarkdown } from './markdown';
import { originBadge, displayReason, userFacingText, toolPreview, previewBody } from './permPreview';
import type { Translate, WvStringKey } from './i18n';

// ═══════════════ 选项分类与排序（对标桌面端 permissionRequest.ts） ═══════════════

export type OptionDisplayKind = 'allowOnce' | 'allowAlways' | 'denyOnce' | 'denyAlways' | 'custom';

/** kind 字符串 → 展示语义（allow/approve/deny/reject/always 子串判定，兼容 allow_once 等变体） */
export function optionDisplayKind(kind: string): OptionDisplayKind {
  const k = kind.trim().toLowerCase();
  const allow = k.includes('allow') || k.includes('approve');
  const deny = k.includes('deny') || k.includes('reject');
  const always = k.includes('always');
  if (allow && always) return 'allowAlways';
  if (allow) return 'allowOnce';
  if (deny && always) return 'denyAlways';
  if (deny) return 'denyOnce';
  return 'custom';
}

/** 各语义下的"泛用名"——名字等于这些时不优先展示原文，改用本地化文案 */
const GENERIC_NAMES: Record<OptionDisplayKind, Set<string>> = {
  allowOnce: new Set(['allow', 'allow once', 'approve']),
  allowAlways: new Set(['always allow', 'allow always', 'approve always']),
  denyOnce: new Set(['deny', 'deny once', 'reject', 'reject once']),
  denyAlways: new Set(['always deny', 'deny always', 'always reject', 'reject always']),
  custom: new Set()
};

/** CLI 原生的已知选项名 → 本地化键（协议里的 name 是英文兜底，UI 统一归一） */
const KNOWN_NAMES: Record<string, { label: WvStringKey; desc?: WvStringKey }> = {
  'full access': { label: 'permFullAccess', desc: 'permDescFullAccess' },
  'always allow in this project': { label: 'permAllowForProject', desc: 'permDescAlways' },
  'always allow in this session': { label: 'permApproveAlways', desc: 'permDescSession' }
};
function knownName(name: string, t: Translate): { label: string; desc?: string } | null {
  const norm = name.trim().replace(/\s+/g, ' ').toLowerCase();
  const hit = KNOWN_NAMES[norm];
  if (!hit) return null;
  const rec: { label: string; desc?: string } = { label: t(hit.label) };
  if (hit.desc) rec.desc = t(hit.desc);
  return rec;
}

function kindPriority(kind: string): number {
  switch (optionDisplayKind(kind)) {
    case 'allowOnce': return 0;
    case 'allowAlways': return 1;
    case 'denyOnce': return 2;
    case 'denyAlways': return 3;
    default: return 4;
  }
}

/** 选项排序：允许一次 → 始终允许 → 拒绝 → 始终拒绝 → 自定义；同优先级保持到达序 */
export function sortPermissionOptions(options: PermissionOption[]): PermissionOption[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => kindPriority(a.option.kind) - kindPriority(b.option.kind) || a.index - b.index)
    .map(({ option }) => option);
}

function optionTexts(opt: PermissionOption, t: Translate): { label: string; desc: string } {
  const dk = optionDisplayKind(opt.kind);
  const known = knownName(opt.name, t);
  const norm = opt.name.trim().replace(/\s+/g, ' ').toLowerCase();
  const generic = GENERIC_NAMES[dk].has(norm);
  // 非泛用名优先展示协议原文（CLI 侧 name 才是给用户看的语义，如 switch_mode 类）
  const fallback: Record<OptionDisplayKind, { label: string; desc: string }> = {
    allowOnce: { label: t('permApproveOnce'), desc: t('permDescOnce') },
    allowAlways: { label: t('permApproveAlways'), desc: t('permDescAlways') },
    denyOnce: { label: t('permDenyOnce'), desc: t('permDescDeny') },
    denyAlways: { label: t('permDenyAlways'), desc: t('permDescDenyAlways') },
    custom: { label: opt.name, desc: opt.description ?? '' }
  };
  if (known) return { label: known.label, desc: known.desc ?? opt.description ?? '' };
  if (!generic && norm && dk !== 'custom') return { label: opt.name, desc: opt.description ?? '' };
  const fb = fallback[dk];
  return { label: fb.label, desc: opt.description ?? fb.desc };
}

/** allowAlways 选项的 bash 规则前缀（对标桌面端 readPermissionRuleScopes）：展示"到底会放行哪些命令" */
function readPermissionRuleScopes(option: PermissionOption): string[] {
  const scopes: string[] = [];
  for (const update of option.response?.permissionUpdates ?? []) {
    if (update.type !== 'addRules' || update.behavior !== 'allow') continue;
    for (const rule of update.rules) {
      if (rule.toolName.toLowerCase() !== 'bash') continue;
      const content = rule.ruleContent?.trim();
      if (!content?.endsWith(':*')) continue;
      // 首行 + 160 字符截断（桌面端同款预算）
      let display = content.slice(0, -2);
      const br = display.search(/\r?\n/);
      if (br !== -1) display = display.slice(0, br);
      if (display.length > 159) display = display.slice(0, 158).trimEnd();
      scopes.push(display ? `${display} …` : '…');
    }
  }
  return scopes.slice(0, 5);
}

// ═══════════════ 草稿与问题行（两通道共享） ═══════════════

/**
 * 交互草稿（键 = requestId，权限/用户输入两通道共用——CLI 的 HZa 会在两条通道复用同一 requestId）。
 * answers 以问题文本为键（CLI $fe schema："User answers keyed by question text"）。
 */
export interface InteractionDraft {
  questionIndex: number;
  answers: Record<string, { selected: string[]; custom: string }>;
  /** 权限卡的拒绝反馈草稿：载荷变化触发重渲染时保住已输入文字 */
  feedback?: string;
}

export function createInteractionDraft(): InteractionDraft {
  return { questionIndex: 0, answers: {} };
}

function draftOf(draft: InteractionDraft, question: string): { selected: string[]; custom: string } {
  return draft.answers[question] ?? (draft.answers[question] = { selected: [], custom: '' });
}

function questionAnswered(d: { selected: string[]; custom: string } | undefined): boolean {
  if (!d) return false;
  return d.selected.length > 0 || d.custom.trim().length > 0;
}

function reqQuestions(input: unknown): UserInputQuestion[] {
  const q = (input ?? {}) as { questions?: UserInputQuestion[] };
  return Array.isArray(q.questions) ? q.questions : [];
}

/**
 * 单题问题行（选项 + 自定义回答行 + preview 区），权限卡与用户输入卡共用。
 * 单选点选：记录 + 选中态 + preview + onSingleSelect()（推进语义由调用方决定）。
 * bindCustomKeys 注入自定义输入行的 Enter/Esc 语义（向导=推进/返回；单题权限不绑定）。
 */
function buildQuestionRows(
  q: UserInputQuestion,
  d: { selected: string[]; custom: string },
  t: Translate,
  onSingleSelect?: () => void,
  onAnyChange?: () => void
): { el: HTMLElement; bindCustomKeys: (onEnter?: () => void, onEscape?: () => void) => void } {
  const list = h('div', { class: 'ui-choices', role: q.multiSelect ? 'group' : 'listbox' });
  const previewEl = h('div', { class: 'ui-preview hidden' });
  const showPreview = (o?: { preview?: string }) => {
    previewEl.classList.add('hidden');
    previewEl.innerHTML = '';
    if (o?.preview) {
      previewEl.append(htmlFragment(renderMarkdown(o.preview)));
      previewEl.classList.remove('hidden');
    }
  };

  if (q.options?.length) {
    q.options.forEach((o, i) => {
      const value = o.value || o.label;
      if (q.multiSelect) {
        const cb = h('input', { type: 'checkbox', class: 'ui-check' }) as HTMLInputElement;
        cb.checked = d.selected.includes(value);
        const row = h('label', { class: `ui-choice${d.selected.includes(value) ? ' selected' : ''}` }, cb,
          h('span', { class: 'opt-body' },
            h('span', { class: 'opt-label' }, o.label),
            o.description ? h('span', { class: 'opt-desc' }, o.description) : null
          ));
        cb.addEventListener('change', () => {
          d.selected = cb.checked ? [...new Set([...d.selected, value])] : d.selected.filter((v) => v !== value);
          row.classList.toggle('selected', cb.checked);
          showPreview(cb.checked ? o : undefined);
          onAnyChange?.();
        });
        list.append(row);
      } else {
        const row = h('button', {
          type: 'button',
          class: `ui-choice${d.selected[0] === value ? ' selected' : ''}`,
          'data-value': value
        },
          h('span', { class: 'opt-num' }, `${i + 1}.`),
          h('span', { class: 'opt-body' },
            h('span', { class: 'opt-label' }, o.label),
            o.description ? h('span', { class: 'opt-desc' }, o.description) : null
          ));
        row.addEventListener('click', () => {
          d.selected = [value];
          d.custom = '';
          list.querySelectorAll('.ui-choice').forEach((n) => n.classList.remove('selected'));
          row.classList.add('selected');
          customRow.classList.remove('selected');
          setCustomIndicator(false);
          showPreview(o);
          onAnyChange?.();
          onSingleSelect?.();
        });
        list.append(row);
      }
    });
  }

  // 自定义回答行（桌面端同款：永远追加在选项之后；多选时左侧为纯展示勾选指示，不劫持点击）
  const customRow = q.multiSelect
    ? h('div', { class: `ui-choice ui-custom-row${d.custom.trim() ? ' selected' : ''}` },
        h('span', { class: 'ui-check-indicator' }, d.custom.trim() ? '✓' : ''))
    : h('div', { class: `ui-choice ui-custom-row${d.custom.trim() ? ' selected' : ''}` },
        h('span', { class: 'opt-num' }, `${(q.options?.length ?? 0) + 1}.`));
  const ta = h('textarea', { class: 'ui-custom-textarea', rows: '1', placeholder: t('customAnswer') }) as HTMLTextAreaElement;
  ta.value = d.custom;
  const setCustomIndicator = (answered: boolean) => {
    const indicator = customRow.querySelector('.ui-check-indicator');
    if (indicator) indicator.textContent = answered ? '✓' : '';
  };
  let composing = false;
  ta.addEventListener('compositionstart', () => { composing = true; });
  ta.addEventListener('compositionend', () => { composing = false; });
  ta.addEventListener('input', () => {
    d.custom = ta.value;
    const answered = d.custom.trim().length > 0;
    customRow.classList.toggle('selected', answered);
    setCustomIndicator(answered);
    if (!q.multiSelect) d.selected = []; // 单选：自定义回答取代选项
    onAnyChange?.();
  });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !composing && !e.isComposing) {
      e.preventDefault();
      customEnter?.();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      customEscape?.();
    }
  });
  // Enter/Esc 语义由调用方注入（向导=推进/返回；单题权限=无操作）
  let customEnter: (() => void) | undefined;
  let customEscape: (() => void) | undefined;
  const bindCustomKeys = (onEnter?: () => void, onEscape?: () => void) => {
    customEnter = onEnter;
    customEscape = onEscape;
  };
  customRow.append(ta);
  list.append(customRow);

  const wrap = h('div', {}, list, previewEl);
  // 已选选项的 preview 回填
  if (!q.multiSelect && d.selected[0]) {
    const o = q.options?.find((x) => (x.value || x.label) === d.selected[0]);
    if (o?.preview) showPreview(o);
  }
  return { el: wrap, bindCustomKeys };
}

/** 权限通道 answers：值必须是字符串（$fe record(G.string())），多选取值 join ", " */
function buildPermissionAnswers(questions: UserInputQuestion[], draft: InteractionDraft): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const d = draft.answers[q.question];
    if (!questionAnswered(d)) continue;
    const values = [...d.selected, ...(d.custom.trim() ? [d.custom.trim()] : [])];
    if (values.length) answers[q.question] = values.join(', ');
  }
  return answers;
}

/** 组装用户输入通道 content：answers 键 = 问题文本，附 answer_N / 单题 answer 兜底（CLI nYa 读取路径） */
function buildUserInputContent(questions: UserInputQuestion[], draft: InteractionDraft): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const d = draft.answers[q.question];
    if (!questionAnswered(d)) return;
    const values = [...d.selected, ...(d.custom.trim() ? [d.custom.trim()] : [])];
    answers[q.question] = values.join(', ');
    content[`answer_${i}`] = q.multiSelect ? values : values[0];
  });
  content.answers = answers;
  if (questions.length === 1 && content.answer_0 !== undefined) content.answer = content.answer_0;
  return content;
}

// ═══════════════ 权限卡（对标桌面端 PermissionDialog） ═══════════════

/**
 * ‹ N/M › 翻页条（权限多题向导与用户输入向导共用）：
 * 上一题/下一题 + 位置文案 + 可选已答圆点容器；末题推进语义由 onNext 注入（权限卡翻页，用户输入卡 advance/submit）。
 */
function buildPagerBar(
  container: HTMLElement,
  count: number,
  draft: InteractionDraft,
  t: Translate,
  onNext: () => void,
  rerender: () => void,
  dotsWrap?: HTMLElement
): void {
  container.classList.add('ix-pager');
  container.innerHTML = '';
  const prevBtn = h('button', { type: 'button', title: t('prevQuestion'), 'aria-label': t('prevQuestion') }, '‹');
  prevBtn.disabled = draft.questionIndex === 0;
  prevBtn.addEventListener('click', () => { draft.questionIndex--; rerender(); });
  const nextBtn = h('button', { type: 'button', title: t('nextQuestion'), 'aria-label': t('nextQuestion') }, '›');
  nextBtn.disabled = draft.questionIndex >= count - 1;
  nextBtn.addEventListener('click', onNext);
  container.append(prevBtn);
  if (dotsWrap) container.append(dotsWrap);
  container.append(
    h('span', { class: 'ix-pager-pos' }, t('questionOf', { n: String(draft.questionIndex + 1), m: String(count) })),
    nextBtn
  );
}

/**
 * 权限卡：
 * - 选项按语义排序 + 编号行 + 数字键直选 + ↑↓/Enter 键盘导航 + Esc 拒绝
 * - 工具身份预览（Edit diff / Write 新文件 / 命令 / URL / Skill / MCP / 文件清单 / 计划模式占位）
 * - AskUserQuestion 类（input.questions）：多题走翻页向导，未答完禁止提交；
 *   answers 以问题文本为键合并进 modifiedInput（CLI $fe superRefine 实证）
 * - allowAlways 选项内联展示 bash 放行前缀；deny 类可附可选反馈（作为拒绝理由上行）
 * - subagent 来源徽章
 */
export function renderPermissionCard(
  req: PermissionRequestParams,
  t: Translate,
  draft: InteractionDraft,
  onRespond: (response: unknown) => void
): HTMLElement {
  const card = h('div', {
    class: `permission-card risk-${req.riskLevel}`,
    'data-request-id': req.requestId,
    tabindex: '0',
    role: 'dialog'
  });
  const preview = toolPreview(req);
  const badge = originBadge(req.origin, t);
  card.append(h('div', { class: 'permission-title' },
    `${t('permissionNeeded')} · ${req.toolName}`,
    badge));

  const questions = reqQuestions(req.input);
  let warn: HTMLElement | null = null;
  const refreshWarn = () => {
    warn?.remove();
    warn = null;
    if (questions.length && !questions.every((q) => questionAnswered(draft.answers[q.question]))) {
      warn = h('div', { class: 'perm-warn' }, t('answersRequired'));
      card.insertBefore(warn, actionsAnchor);
    }
  };

  if (preview.family === 'switchMode') {
    // 计划模式退出无参数可审：占位动画（桌面端同款，不渲染 reason/预览）
    card.append(h('div', { class: 'perm-placeholder' },
      h('span', { class: 'perm-spinner' }, '◌'),
      h('span', {}, t('switchModePlaceholder'))));
  } else {
    const reason = displayReason(req);
    if (reason) card.append(h('div', { class: 'permission-reason' }, reason));
    if (questions.length > 1) {
      card.append(buildPermissionWizard(req, draft, t, refreshWarn));
    } else if (questions.length === 1) {
      const q = questions[0];
      draft.questionIndex = 0;
      card.append(h('div', { class: 'ui-q-header' },
        h('span', { class: 'q-badge' }, q.header ?? 'Q1')), h('div', { class: 'ui-q-text' }, q.question));
      const rows = buildQuestionRows(q, draftOf(draft, q.question), t);
      card.append(h('div', { class: 'perm-questions' }, rows.el));
    } else {
      const body = previewBody(preview, t);
      if (body) card.append(body);
      else if (req.input !== undefined && req.input !== null && typeof req.input === 'object'
        && preview.family !== 'mcp' && preview.family !== 'search' && preview.family !== 'skill') {
        card.append(h('details', { class: 'permission-input' }, h('summary', {}, 'input'), jsonBlock(req.input)));
      }
    }
  }

  const ordered = sortPermissionOptions(req.options ?? []);
  let selectedIndex = Math.max(0, ordered.findIndex((o) => optionDisplayKind(o.kind) === 'allowOnce'));
  const denyOption = ordered.find((o) => optionDisplayKind(o.kind).startsWith('deny'));

  // 拒绝反馈（对标桌面端 feedback 行）：仅 deny 类提交时上行，trim 后非空才带；草稿随 InteractionDraft 保持
  const feedbackTa = denyOption
    ? h('textarea', { class: 'ui-custom-textarea perm-feedback', rows: '1', placeholder: t('permFeedbackPlaceholder') }) as HTMLTextAreaElement
    : null;
  if (feedbackTa) feedbackTa.value = draft.feedback ?? '';

  const respondWith = (opt: PermissionOption) => {
    if (questions.length && !questions.every((q) => questionAnswered(draft.answers[q.question]))) {
      refreshWarn();
      return;
    }
    const resp = { ...((opt.response ?? {}) as unknown as Record<string, unknown>) };
    // AskUserQuestion：answers 合并进 modifiedInput（键 = 问题文本，值为字符串）
    if (questions.length) {
      const answers = buildPermissionAnswers(questions, draft);
      if (Object.keys(answers).length) resp.modifiedInput = { ...((req.input ?? {}) as object), answers };
    }
    // deny 附反馈：CLI VZa 把 reason 作为拒绝理由递送（freeText 同源语义）
    if (optionDisplayKind(opt.kind).startsWith('deny') && feedbackTa) {
      const fb = feedbackTa.value.trim();
      if (fb) resp.reason = fb;
    }
    onRespond(resp);
  };

  const optionsEl = h('div', { class: 'perm-options', role: 'listbox' });
  const rows: HTMLElement[] = [];
  const paint = () => {
    rows.forEach((r, i) => {
      r.classList.toggle('focused', i === selectedIndex);
      r.setAttribute('aria-selected', String(i === selectedIndex));
    });
  };
  ordered.forEach((opt, i) => {
    const dk = optionDisplayKind(opt.kind);
    const texts = optionTexts(opt, t);
    const scopes = dk === 'allowAlways' ? readPermissionRuleScopes(opt) : [];
    const row = h('button', {
      type: 'button',
      class: `perm-option kind-${dk}`,
      role: 'option',
      'aria-selected': 'false',
      onclick: () => {
        if (i === selectedIndex) { respondWith(opt); return; }
        selectedIndex = i;
        paint();
      }
    },
      h('span', { class: 'perm-num' }, `${i + 1}.`),
      h('span', { class: 'perm-opt-body' },
        h('span', { class: 'perm-name' }, texts.label),
        texts.desc ? h('span', { class: 'perm-desc' }, texts.desc) : null,
        scopes.length ? h('span', { class: 'perm-scopes' },
          ...scopes.map((s) => h('code', { class: 'perm-scope' }, s))) : null
      )
    );
    rows.push(row);
    optionsEl.append(row);
  });
  paint();

  const actionsAnchor = h('div', {});
  card.append(optionsEl);
  if (feedbackTa) {
    let composing = false;
    feedbackTa.addEventListener('compositionstart', () => { composing = true; });
    feedbackTa.addEventListener('compositionend', () => { composing = false; });
    feedbackTa.addEventListener('input', () => { draft.feedback = feedbackTa.value; });
    feedbackTa.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // 反馈行 Enter = 以反馈提交拒绝（桌面端 submitFeedback 同款）
      if (e.key === 'Enter' && !e.shiftKey && !composing && !e.isComposing && denyOption) {
        e.preventDefault();
        if (feedbackTa.value.trim()) respondWith(denyOption);
      }
    });
    card.append(h('div', { class: 'perm-feedback-row' }, feedbackTa));
  }
  card.append(actionsAnchor);

  // 页脚：键盘提示 + 确认按钮（提交当前选中项）
  const confirmBtn = h('button', {
    type: 'button',
    class: 'permission-btn primary',
    onclick: () => { const opt = ordered[selectedIndex]; if (opt) respondWith(opt); }
  }, t('permConfirm'));
  card.append(h('div', { class: 'permission-footer' },
    h('span', { class: 'perm-kbd-hint' }, t('permKbdHint')),
    confirmBtn
  ));
  if (questions.length) refreshWarn();

  // 键盘导航：焦点在问题区内→问题行，否则→权限选项；Esc = 拒绝；textarea 内不拦截
  card.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    if (e.key === 'Escape' && denyOption) {
      e.preventDefault();
      respondWith(denyOption);
      return;
    }
    // 焦点位于问题选项行：↑↓/Tab 在问题行间移动（原生 Enter=点选）
    const inQuestion = !!card.querySelector('.perm-questions .ui-choice:focus, .perm-qwizard .ui-choice:focus');
    if (inQuestion && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const qRows = Array.from(card.querySelectorAll('.perm-questions .ui-choice, .perm-qwizard .ui-choice')) as HTMLElement[];
      const cur = qRows.indexOf(document.activeElement as HTMLElement);
      const dir = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) || e.key === 'ArrowLeft' ? -1 : 1;
      qRows[(cur < 0 ? (dir > 0 ? 0 : qRows.length - 1) : cur + dir + qRows.length) % qRows.length]?.focus();
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) || e.key === 'ArrowLeft') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + rows.length) % Math.max(rows.length, 1);
      paint();
    } else if (e.key === 'ArrowDown' || e.key === 'Tab' || e.key === 'ArrowRight') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % Math.max(rows.length, 1);
      paint();
    } else if (/^[1-9]$/.test(e.key)) {
      const opt = ordered[Number(e.key) - 1];
      if (opt) { e.preventDefault(); respondWith(opt); }
    } else if (e.key === 'Enter' && e.target === card) {
      e.preventDefault();
      const opt = ordered[selectedIndex];
      if (opt) respondWith(opt);
    }
  });

  return card;
}

/**
 * 权限卡多题向导：‹ N/M › 翻页 + 已答圆点；单选点选自动翻下一题（末题停留——提交由选项行承担）。
 * 返回元素自带内部重渲染，answersComplete 由外部 refreshWarn 感知（每次翻页/作答后回调）。
 */
function buildPermissionWizard(
  req: PermissionRequestParams,
  draft: InteractionDraft,
  t: Translate,
  onChange: () => void
): HTMLElement {
  const questions = reqQuestions(req.input);
  const wrap = h('div', { class: 'perm-qwizard' });
  const pager = h('div', { class: 'ix-pager' });
  const body = h('div', { class: 'ix-q-body' });
  wrap.append(pager, body);
  // 已答圆点：已答题实心，当前题描边；作答即时刷新（多选勾选/自定义输入也走这里）
  const dotsWrap = h('span', { class: 'ix-dots' });
  const refreshDots = () => {
    dotsWrap.innerHTML = '';
    questions.forEach((qq, i) => dotsWrap.append(h('span', {
      class: `ix-dot${i === draft.questionIndex ? ' current' : ''}${questionAnswered(draft.answers[qq.question]) ? ' answered' : ''}`
    })));
  };

  const renderQuestion = () => {
    if (draft.questionIndex >= questions.length) draft.questionIndex = questions.length - 1;
    const q = questions[draft.questionIndex];
    refreshDots();
    buildPagerBar(pager, questions.length, draft, t, () => {
      if (draft.questionIndex < questions.length - 1) { draft.questionIndex++; renderQuestion(); onChange(); }
    }, renderQuestion, dotsWrap);

    body.innerHTML = '';
    body.append(h('div', { class: 'ui-q-header' },
      h('span', { class: 'q-badge' }, q.header ?? `Q${draft.questionIndex + 1}`)));
    body.append(h('div', { class: 'ui-q-text' }, q.question));
    const rowsEl = buildQuestionRows(q, draftOf(draft, q.question), t, () => {
      // 单选点选：记录后自动翻下一题；末题停留等待选项提交
      if (draft.questionIndex < questions.length - 1) { draft.questionIndex++; renderQuestion(); }
      onChange();
    }, () => { refreshDots(); onChange(); });
    body.append(rowsEl.el);
  };
  renderQuestion();
  return wrap;
}

// ═══════════════ 用户输入卡（单题向导，对标桌面端 ElicitationDialog） ═══════════════

/**
 * 用户输入卡：一次只展示一题（‹ N/M › 翻页），选项行 + 自定义回答输入行 + preview 展示。
 * 单选点选自动推进（末题提交）；Esc 返回上一题，首页 Esc = 取消；未答题允许跳过（CLI 空答案语义）。
 */
export function renderUserInputCard(
  req: UserInputRequestParams,
  t: Translate,
  draft: InteractionDraft,
  onRespond: (response: unknown) => void
): HTMLElement {
  const card = h('div', { class: 'user-input-card', 'data-request-id': req.requestId, tabindex: '0', role: 'dialog' });
  const input = (req.input ?? {}) as { questions?: UserInputQuestion[] };
  const questions = req.questions?.length ? req.questions : (input.questions ?? []);

  // ── 纯 prompt（无问题）：自由文本回 content.answer ──
  if (!questions.length) {
    card.append(h('div', { class: 'permission-title' },
      req.toolName ?? (req.prompt ?? t('respond')),
      originBadge(req.origin, t)));
    const plainReason = userFacingText(req.prompt);
    if (plainReason && req.toolName) card.append(h('div', { class: 'permission-reason' }, plainReason));
    const ta = h('textarea', { class: 'ui-textarea', rows: '2' }) as HTMLTextAreaElement;
    let composing = false;
    ta.addEventListener('compositionstart', () => { composing = true; });
    ta.addEventListener('compositionend', () => { composing = false; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !composing && !e.isComposing) {
        e.preventDefault();
        const text = ta.value.trim();
        if (text) onRespond({ action: 'accept', content: { answer: text } });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onRespond({ action: 'decline' });
      }
    });
    card.append(ta, h('div', { class: 'permission-footer' },
      h('span', { class: 'perm-kbd-hint' }, t('ixKbdHint')),
      h('div', { class: 'permission-actions' },
        h('button', { type: 'button', class: 'permission-btn', onclick: () => onRespond({ action: 'decline' }) }, t('decline')),
        h('button', { type: 'button', class: 'permission-btn primary', onclick: () => {
          const text = ta.value.trim();
          if (text) onRespond({ action: 'accept', content: { answer: text } });
        } }, t('submit'))
      )
    ));
    return card;
  }

  // ── 问题向导 ──
  // 标题优先 toolName（卡片语境即"谁在问"），prompt 仅在用户可读时作为副标题展示
  card.append(h('div', { class: 'permission-title' }, req.toolName ?? t('respond'), originBadge(req.origin, t)));
  const subtitle = userFacingText(req.prompt);
  if (subtitle && req.toolName) card.append(h('div', { class: 'permission-reason' }, subtitle));

  const pager = h('div', { class: 'ix-pager' });
  const body = h('div', { class: 'ix-q-body' });
  card.append(pager, body);

  const submit = () => onRespond({ action: 'accept', content: buildUserInputContent(questions, draft) });
  const decline = () => onRespond({ action: 'decline' });

  /** 渲染当前题：头部徽章 + 问题 + 选项行（含自定义行）+ preview */
  let renderQuestion = (): void => {
    const q = questions[draft.questionIndex];
    buildPagerBar(pager, questions.length, draft, t, () => advance(), renderQuestion);

    body.innerHTML = '';
    const d = draftOf(draft, q.question);
    body.append(h('div', { class: 'ui-q-header' },
      h('span', { class: 'q-badge' }, q.header ?? `Q${draft.questionIndex + 1}`)));
    body.append(h('div', { class: 'ui-q-text' }, q.question));
    const rowsEl = buildQuestionRows(q, d, t, () => {
      // 单选：记录后自动推进（末题直接提交——桌面端同款语义）
      if (draft.questionIndex >= questions.length - 1) submit();
      else { draft.questionIndex++; renderQuestion(); }
    });
    body.append(rowsEl.el);
    rowsEl.bindCustomKeys(
      () => advance(),   // 自定义输入行 Enter = 推进/提交
      () => back()       // Esc = 返回上一题/取消
    );
  };

  /** 推进：焦停在选项上且未作答时视为选中（焦点即意图——桌面端同款） */
  const advance = () => {
    const q = questions[draft.questionIndex];
    const d = draftOf(draft, q.question);
    const hasAnswer = d.selected.length > 0 || d.custom.trim().length > 0;
    if (!hasAnswer && !q.multiSelect) {
      const focused = body.querySelector('.ui-choices .ui-choice:focus') as HTMLElement | null;
      const value = focused?.getAttribute('data-value');
      if (value && focused) { d.selected = [value]; focused.classList.add('selected'); }
    }
    if (draft.questionIndex >= questions.length - 1) submit();
    else { draft.questionIndex++; renderQuestion(); }
  };

  /** 返回上一题；首页返回 = 取消（桌面端同款） */
  const back = () => {
    if (draft.questionIndex > 0) { draft.questionIndex--; renderQuestion(); }
    else decline();
  };

  // 主按钮文案随题目位置同步（末题=提交，中间题=继续）
  const primaryLabel = () => (draft.questionIndex >= questions.length - 1 ? t('submit') : t('continueBtn'));
  const primaryBtn = h('button', { type: 'button', class: 'permission-btn primary' }, primaryLabel());
  primaryBtn.addEventListener('click', () => advance());
  card.append(h('div', { class: 'permission-footer' },
    h('span', { class: 'perm-kbd-hint' }, t('ixKbdHint')),
    h('div', { class: 'permission-actions' },
      h('button', { type: 'button', class: 'permission-btn', onclick: () => decline() }, t('decline')),
      primaryBtn
    )
  ));
  const origRender = renderQuestion;
  renderQuestion = () => { origRender(); primaryBtn.textContent = primaryLabel(); };

  // 键盘：↑↓/Tab 在选项行间移动焦点，Enter 激活焦点行，数字键直选，Esc 返回/取消
  card.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    const rowBtns = Array.from(card.querySelectorAll('.ix-q-body .ui-choices .ui-choice')) as HTMLElement[];
    const current = rowBtns.indexOf(document.activeElement as HTMLElement);
    const focusRow = (i: number) => { rowBtns[(i + rowBtns.length) % rowBtns.length]?.focus(); };
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowRight') {
      e.preventDefault(); focusRow(current < 0 ? 0 : current + 1);
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) || e.key === 'ArrowLeft') {
      e.preventDefault(); focusRow(current < 0 ? rowBtns.length - 1 : current - 1);
    } else if (/^[1-9]$/.test(e.key)) {
      const row = rowBtns[Number(e.key) - 1];
      if (row) { e.preventDefault(); row.click(); }
    } else if (e.key === 'Enter') {
      const el = e.target as HTMLElement;
      if (el !== card && el.tagName !== 'BUTTON' && el.classList?.contains('ui-choice')) {
        // 多选行是 label（无原生 Enter 激活）——转发到内部勾选框
        e.preventDefault();
        (el.querySelector('.ui-check') as HTMLElement | null)?.click();
        return;
      }
      if (el !== card) return; // 焦点在选项按钮上由原生 click 语义处理
      e.preventDefault();
      advance();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      back();
    }
  });

  renderQuestion();
  return card;
}
