/**
 * [INPUT]: 无依赖（Locale 为类型导入）
 * [OUTPUT]: 对外提供 formatTokens/fmtContext/sourceLabel/sourceColor/formatTokensLocale/fmtContextLocale 展示格式化工具
 * [POS]: webview 的数字与标签格式化层，chat.ts（上下文圆环）与 menus.ts（上下文菜单）消费
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
