/**
 * [INPUT]: 依赖 marked
 * [OUTPUT]: 对外提供 renderMarkdown()（助手文本 → 安全 HTML 片段）
 * [POS]: webview 的 markdown 渲染层，chat.ts 渲染助手消息时消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** 流式渲染中抑制未闭合代码块造成的整段样式坍塌：补一个临时闭合 */
export function renderMarkdown(text: string): string {
  const fenceCount = (text.match(/^```/gm) ?? []).length;
  const balanced = fenceCount % 2 === 0 ? text : text + '\n```';
  return marked.parse(balanced, { async: false }) as string;
}
