/**
 * [INPUT]: 无依赖
 * [OUTPUT]: 对外提供 formatTokens/fmtContext/sourceLabel 展示格式化工具
 * [POS]: webview 的数字与标签格式化层，chat.ts（上下文圆环）与 menus.ts（上下文菜单）消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function fmtContext(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(0)}M` : `${Math.round(n / 1000)}K`;
}

/** 上下文来源键 → 人话标签 */
export function sourceLabel(src: string): string {
  const MAP: Record<string, string> = {
    system_prompt: 'System prompt',
    meta_user_context: 'User context',
    skills: 'Skills',
    tool_prompt: 'Tools',
    system_tool_schemas: 'Tool schemas',
    mcp_tool_schemas: 'MCP schemas',
    messages: 'Messages'
  };
  return MAP[src] ?? src;
}
