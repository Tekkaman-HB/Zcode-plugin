# src/ui/webview/
> L2 | 父级: ../CLAUDE.md

## 成员清单

main.ts: 聊天视图入口，acquireVsCodeApi 装配 + 桥接消息监听
chat.ts: 聊天应用中枢——状态机、桥接事件适配（宽容解析）、交互（发送/附件/@引用/斜杠补全/模型下拉/模式+思考强度下拉/历史会话下拉/配置收纳齿轮：重试/用量/MCP/命令）；交互焦点队列（权限/用户输入统一排队 + tab 可点切换 + 草稿保持 + 焦点管理）
render.ts: 纯函数 DOM 渲染层——h()/esc()/jsonBlock()/diffBlock()/isAskUserQuestion() 工具、消息/部件/工具卡片渲染器（含 AskUserQuestion 问答摘要卡；权限/用户输入卡片已迁至 ./interaction）
interaction.ts: 交互卡渲染层——权限卡（选项语义排序/分类/键盘导航（含 Esc 拒绝）/多题翻页向导+已答圆点/拒绝反馈行/bash 放行前缀/subagent 来源徽章）+ 用户输入卡（单题向导/自定义回答行/选项 preview/应答组装 answers 键=问题文本）；两向导共用 buildPagerBar 翻页条；两通道共享 InteractionDraft 草稿
permPreview.ts: 工具身份分流与权限预览子层（resolveToolFamily：edit·write·execute·search·skill·mcp·switchMode·files；previewBody 对应渲染；displayReason 滤协议诊断文案；originBadge）
markdown.ts: marked 封装，流式未闭合代码块补偿
i18n.ts: webview 侧文案（zh-CN/en-US）
styles.css: 全部样式——Beautiful UI（beautifului.dev）设计系统逐值移植：oklch 令牌（page/canvas/surface/inset/ink×3/line×3/field/accent+green/orange/red 及 tints）× 明暗双主题（body.vscode-dark 覆写）、四档圆角（chip 6/control 8/card 10/window 14）、多层柔影（hairline/btn/card/raised/overlay）、动画原语（fade-up/pop-in/caret-blink/shimmer-text/pixel-on/records-pulse）、Inter 可变字重（latin 子集）

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
