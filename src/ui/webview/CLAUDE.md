# src/ui/webview/
> L2 | 父级: ../CLAUDE.md

## 成员清单

main.ts: 聊天视图入口，acquireVsCodeApi 装配 + 桥接消息监听
chat.ts: 聊天应用壳——共享状态持有者（EventHost/QueueHost/MenuHost 的宿主实现）、桥接消息入口 onMessage、投影补丁、流式刷新管线、头部/横幅/欢迎页/发送供能、composer 输入与 slash/@ 弹层（需改写输入框文本故留在本层）、附件行/排队条/lightbox；菜单与队列经薄委托别名转发子模块
events.ts: 协议事件适配层——applySessionEvent()（session/event → 状态机，宽容解析信封 payload 兜底）、ChatSessionState/MutableSessionMessage 状态形状、EventHost 接口与 extractMessage 等适配工具
queue.ts: 交互焦点队列——renderPermissionCards()（权限/用户输入统一排队、tab 可点切换 ixSelected、requestId 去重、一次亮一张）、submitUserInput 应答与队列推进；QueueHost 接口
menus.ts: 弹层菜单控制器 MenuController——模型（含推理档位）/上下文圆环弹层/齿轮配置（重试+用量+MCP+命令）/模式（含 Effort 圆点）/历史会话菜单，popup 定位设施（chat 的 slash/@ 弹层共用）与 composer 弹层按键导航
render.ts: 纯函数 DOM 渲染层——h()/esc()/jsonBlock()/diffBlock()/isAskUserQuestion() 工具、消息/部件/工具卡片渲染器（含 AskUserQuestion 问答摘要卡；权限/用户输入卡片见 ./interaction）
interaction.ts: 交互卡渲染层——权限卡（选项语义排序/分类/键盘导航（含 Esc 拒绝）/多题翻页向导+已答圆点/拒绝反馈行/bash 放行前缀/subagent 来源徽章）+ 用户输入卡（单题向导/自定义回答行/选项 preview/应答组装 answers 键=问题文本）；两向导共用 buildPagerBar 翻页条；两通道共享 InteractionDraft 草稿
permPreview.ts: 工具身份分流与权限预览子层（resolveToolFamily：edit·write·execute·search·skill·mcp·switchMode·files；previewBody 对应渲染；displayReason 滤协议诊断文案；originBadge）
icons.ts: 内联 SVG 图标层——MODE_ICONS 表（chip 与模式菜单共用）与 Z 标/@/齿轮/+/时钟图标工厂
format.ts: 展示格式化层——formatTokens/fmtContext（圆环与菜单）与 sourceLabel（上下文来源标签）
markdown.ts: marked 封装，流式未闭合代码块补偿
i18n.ts: webview 侧文案（zh-CN/en-US）
styles.css: 全部样式——Beautiful UI（beautifului.dev）设计系统逐值移植：oklch 令牌（page/canvas/surface/inset/ink×3/line×3/field/accent+green/orange/red 及 tints）× 明暗双主题（body.vscode-dark 覆写）、四档圆角（chip 6/control 8/card 10/window 14）、多层柔影（hairline/btn/card/raised/overlay）、动画原语（fade-up/pop-in/caret-blink/shimmer-text/pixel-on/records-pulse）、Inter 可变字重（latin 子集）

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
