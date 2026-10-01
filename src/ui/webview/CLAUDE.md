# src/ui/webview/
> L2 | 父级: ../CLAUDE.md

## 成员清单

main.ts: 聊天视图入口，acquireVsCodeApi 装配 + 桥接消息监听
chat.ts: 聊天应用壳——共享状态持有者（EventHost/QueueHost/MenuHost 的宿主实现）、桥接消息入口 onMessage、投影补丁、流式刷新管线、diff 式 rebuildMessages（rendered 快照 Map 复用未变消息节点+流式消息跳过重建+.replaced 抑制动画——全量重建是闪烁根因；renderMessage 返回 null 的被过滤消息移除节点且不破坏链序）、头部/横幅/欢迎页/发送供能、composer 输入与 slash/@ 弹层（需改写输入框文本故留在本层）、附件行/排队条/lightbox；菜单与队列经薄委托别名转发子模块；进程面板挂载与刷新（rebuildMessages/scheduleFlush 末尾 → ./todoPanel）
events.ts: 协议事件适配层——applySessionEvent()（session/event → 状态机，宽容解析信封 payload 兜底）、ChatSessionState/MutableSessionMessage 状态形状、EventHost 接口与 extractMessage/normalizeMessageId 等适配工具（后者归一服务端消息 id 双方言：resume 载荷 info.messageId vs session/messages 载荷 info.id，原地回填——不归一则 DOM data-message-id 为空成幽灵节点，resume 后渲染整会话叠加）
queue.ts: 交互焦点队列——renderPermissionCards()（权限/用户输入统一排队、tab 可点切换 ixSelected、requestId 去重、一次亮一张）、submitUserInput 应答与队列推进；QueueHost 接口
menus.ts: 弹层菜单控制器 MenuController——模型（含推理档位：行布局=名称左+窗口标识/档位胶囊组右对齐，选中模型 accent-tint 底色、当前档位 lv-btn.active accent 实底白字）/上下文弹层（对标桌面端"上下文容量"：标题行+分段色条+彩点来源行，zh 万计量全角括号；明细快照由 chat.ts 落 localStorage 跨重载可见）/齿轮配置（重试+MCP+命令）/模式（含 Effort 圆点）/历史会话菜单（对标桌面端搜索列表：标题单行省略 .session-menu-name + meta 同行右侧 .session-menu-meta；列表异步注入后 positionPopup() 重钳制——替换内容不重定位会把宽弹层留在窄内容的旧位置溢出视口），popup 定位设施（positionPopup 可复用；chat 的 slash/@ 弹层共用）与 composer 弹层按键导航
render.ts: 纯函数 DOM 渲染层——h()/esc()/jsonBlock()/diffBlock()/isAskUserQuestion()/isTodoWrite()/isSystemReminderText() 工具、消息/部件/工具卡片渲染器（renderMessage 可返回 null=整条被过滤：user 分支无可见子节点或 parts 非空但全被过滤时不渲染空壳，info.visibility=model-only 的服务端注入（todo 提醒/后台任务，无标签裸文本）整条过滤；parts 为空的流式空消息保留"思考中"占位；system-reminder 元文本整段过滤——marked 会把标签吞成不可见元素致内容裸奔；AskUserQuestion 问答摘要卡 + TodoWrite 任务清单卡：状态点三态+完成数摘要，默认折叠、userExpanded/userCollapsed 双集合记忆；权限/用户输入卡片见 ./interaction）
todoPanel.ts: 进程面板层——extractLatestTodos()（消息集反向扫描 → 最近 TodoWrite 推导，callId 为任务身份；推导式不持状态）+ renderTodoPanel()（消息流与 composer 间常驻条：状态点+计数+当前任务单行省略，展开复用 .todo-item 三态样式；点击头行立即重建；**全部完成时头行渲染关闭按钮**，chat.ts 按 todoClosedCallId 记忆关闭——仅同任务隐藏、新一轮 TodoWrite（新 callId）自动重现、会话切换重置；无清单/已关闭隐藏）
interaction.ts: 交互卡渲染层——权限卡（选项语义排序/分类/键盘导航（含 Esc 拒绝）/多题翻页向导+已答圆点/拒绝反馈行/bash 放行前缀/subagent 来源徽章）+ 用户输入卡（单题向导/自定义回答行/选项 preview/应答组装 answers 键=问题文本）；两向导共用 buildPagerBar 翻页条；两通道共享 InteractionDraft 草稿
permPreview.ts: 工具身份分流与权限预览子层（resolveToolFamily：edit·write·execute·search·skill·mcp·switchMode·files；previewBody 对应渲染；displayReason 滤协议诊断文案；originBadge）
icons.ts: 内联 SVG 图标层——MODE_ICONS 表（chip 与模式菜单共用）与 Z 标/@/齿轮/+/时钟图标工厂
format.ts: 展示格式化层——formatTokens/fmtContext（圆环与菜单）、sourceLabel（上下文来源标签，zh 对齐桌面端"消息/系统工具/技能…"）、sourceColor（来源→类别色，分段条与彩点同映射）、formatTokensLocale/fmtContextLocale（zh 万/亿计量，如"31.6万/100万"）
markdown.ts: marked 封装，流式未闭合代码块补偿
i18n.ts: webview 侧文案（zh-CN/en-US）
styles.css: 全部样式——Beautiful UI（beautifului.dev）设计系统逐值移植：oklch 令牌（page/canvas/surface/inset/ink×3/line×3/field/accent+green/orange/red 及 tints）× 明暗双主题（body.vscode-dark 覆写）、四档圆角（chip 6/control 8/card 10/window 14）、多层柔影（hairline/btn/card/raised/overlay）、动画原语（fade-up/pop-in/caret-blink/shimmer-text/pixel-on/records-pulse）、Inter 可变字重（latin 子集）

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
