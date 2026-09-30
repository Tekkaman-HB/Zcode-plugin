# src/ui/
> L2 | 父级: ../CLAUDE.md

## 成员清单

bridge.ts: 扩展↔webview 消息契约（ToWebviewMessage/FromWebviewMessage），两端共同消费，不含运行时代码
chatProvider.ts: 聊天视图宿主（WebviewViewProvider），HTML/CSP 生成（style-src 'unsafe-inline' 必需——CSP 静默剥离 setAttribute 的 style 属性，详见 L1"CSP 剥 style 属性"条目）、桥接消息分发到 SessionController

## 子目录

webview/: webview 前端（见 webview/CLAUDE.md）

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
