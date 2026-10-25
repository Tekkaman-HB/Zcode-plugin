/**
 * [INPUT]: 依赖 marked
 * [OUTPUT]: renderMarkdown（助手文本 → HTML）与 splitStreamingMarkdown（保留未定稿尾块，分离已完成前缀）
 * [POS]: webview 的 markdown 渲染层，chat.ts 渲染助手消息时消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** 最后一个非空块仍可能变成表格、列表或代码块，保留到下一块出现再定稿。 */
export function splitStreamingMarkdown(text: string): { complete: string; pending: string } {
  const tokens = marked.lexer(text);
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last].type === 'space') last--;
  const length = tokens.slice(0, Math.max(0, last)).reduce((n, token) => n + token.raw.length, 0);
  return { complete: text.slice(0, length), pending: text.slice(length) };
}

/** 流式渲染中抑制未闭合代码块造成的整段样式坍塌：补一个临时闭合 */
export function renderMarkdown(text: string): string {
  const fenceCount = (text.match(/^```/gm) ?? []).length;
  const balanced = fenceCount % 2 === 0 ? text : text + '\n```';
  return marked.parse(balanced, { async: false }) as string;
}
