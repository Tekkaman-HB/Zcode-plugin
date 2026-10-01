/**
 * [INPUT]: 无依赖（Locale 为类型导入）
 * [OUTPUT]: 对外提供 formatTokens/fmtContext/sourceLabel/sourceColor/formatTokensLocale/fmtContextLocale 展示格式化工具与 extractContentTexts/normalizeToolOutputText 工具输出规整
 * [POS]: webview 的数字、标签与工具输出文本规整层，chat.ts（上下文圆环）、menus.ts（上下文菜单）、events.ts（工具结果提取）与 render.ts（工具卡输出渲染）消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { Locale } from './i18n';

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function fmtContext(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(0)}M` : `${Math.round(n / 1000)}K`;
}

/** 中文计量（对标桌面端"31.6万/100万"）；英文沿用 k/M */
export function formatTokensLocale(n: number, locale: Locale): string {
  if (locale !== 'zh-CN') return formatTokens(n);
  if (n >= 1e8) return `${Math.round((n / 1e8) * 10) / 10}亿`;
  if (n >= 1e4) {
    const v = n / 1e4;
    return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}万`;
  }
  return String(n);
}

export function fmtContextLocale(n: number, locale: Locale): string {
  if (locale !== 'zh-CN') return fmtContext(n);
  if (n >= 1e8) return `${Math.round((n / 1e8) * 10) / 10}亿`;
  if (n >= 1e4) return `${Math.round(n / 1e4)}万`;
  return String(n);
}

/** 上下文来源键 → 人话标签（zh 对齐桌面端"消息/系统工具/技能…"） */
export function sourceLabel(src: string, locale: Locale = 'en-US'): string {
  if (locale === 'zh-CN') {
    const ZH: Record<string, string> = {
      system_prompt: '系统提示词',
      meta_user_context: '用户上下文',
      skills: '技能',
      tool_prompt: '工具提示词',
      system_tool_schemas: '系统工具',
      mcp_tool_schemas: 'MCP 工具',
      messages: '消息'
    };
    return ZH[src] ?? src;
  }
  const EN: Record<string, string> = {
    system_prompt: 'System prompt',
    meta_user_context: 'User context',
    skills: 'Skills',
    tool_prompt: 'Tools',
    system_tool_schemas: 'Tool schemas',
    mcp_tool_schemas: 'MCP schemas',
    messages: 'Messages'
  };
  return EN[src] ?? src;
}

/** 上下文来源 → 类别色（分段色条与彩点共用同一映射，保证两处对色） */
export function sourceColor(src: string): string {
  const MAP: Record<string, string> = {
    messages: 'var(--accent)',
    mcp_tool_schemas: 'var(--green)',
    system_tool_schemas: 'var(--orange)',
    skills: 'var(--red)',
    meta_user_context: 'var(--accent-ink)',
    tool_prompt: 'var(--ink-2)',
    system_prompt: 'var(--ink-3)'
  };
  return MAP[src] ?? 'var(--ink-3)';
}

// ═══════════════ 工具输出规整 ═══════════════

/** 内容块数组 → 文本数组（MCP 标准 [{type:'text',text}] 与 zai 变体 [{text}] 通吃；无文本块返回 null） */
function blockTexts(arr: unknown): string[] | null {
  if (!Array.isArray(arr) || !arr.length) return null;
  const texts: string[] = [];
  for (const b of arr) {
    if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
      const t = (b as { text: string }).text;
      if (t) texts.push(t);
    }
  }
  return texts.length ? texts : null;
}

/**
 * 结果对象 → 内容块文本（events 工具结果提取与 render 输出规整共用）：
 * 顶层数组直接按块数组读；对象要求全部值都是块数组才视为内容（防误伤普通 JSON 结果对象）。
 */
export function extractContentTexts(value: unknown): string[] | null {
  if (Array.isArray(value)) return blockTexts(value);
  if (!value || typeof value !== 'object') return null;
  const texts: string[] = [];
  for (const v of Object.values(value)) {
    const t = blockTexts(v);
    if (!t) return null;
    texts.push(...t);
  }
  return texts.length ? texts : null;
}

/**
 * 工具输出串规整：CLI/兜底序列化拍平的内容块 JSON（含 `label: [...]` / `**label:** [...]` 前缀变体，
 * 换行已逃逸成字面 \n）→ 还原为真实换行的多行文本；非该形状原样返回。
 */
export function normalizeToolOutputText(output: string): string {
  const candidate = output.replace(/^\s*(?:\*\*)?[\w.]{1,80}(?:\*\*)?\s*[:：]\s*/, '').trim();
  if (!candidate.startsWith('[') && !candidate.startsWith('{')) return output;
  try {
    const texts = extractContentTexts(JSON.parse(candidate));
    if (texts) return texts.join('\n\n');
  } catch { /* 非 JSON 或解析失败：原样 */ }
  return output;
}
