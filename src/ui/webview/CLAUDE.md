# src/ui/webview/
> L2 | 父级: ../CLAUDE.md

## 成员清单

main.ts: acquireVsCodeApi 装配与消息监听，挂载 ChatApp
chat.ts: ChatApp 共享状态与桥接入口，事件适配/交互队列/菜单/输入/模态的 Host 实现；消息 id/parts 方言归一、模型权威列表保护、快照 diff、流式增量与滚动跟随；服务状态复用 bridge 类型，仅 ready 允许发送
shell.ts: 展示骨架与刷新，导航/欢迎页/本地模式/一体式 composer、模型名称与低/中/高标签、统一盾牌叹号权限入口（完全访问警示色）与上下文圆环
composer.ts: ComposerController 输入层，IME/Enter/Shift+Enter、附件粘贴/移除、@ 文件浏览与 slash 选择、发送/停止、排队展示和缩略图回填；状态仍由 ChatApp 持有
panels.ts: PanelsController 模态层，附件 lightbox 与手机配对展示；Esc/背景关闭、Tab 焦点约束、触发焦点恢复、配对刷新保留焦点与二维码
events.ts: session/event 适配，ChatSessionState/MutableSessionMessage/EventHost 与消息 id/工具结果归一；保持 optimistic-user 与权威回显合并
queue.ts: 权限/问答统一焦点队列，requestId 去重、交互 tab 与草稿保持、一次展示一张与应答推进
menus.ts: MenuController 唯一 popup 实现，模型与横排低/中/高思考强度（原始档位发送、缺档禁用、左右键导航）、四种权限模式、附件、聊天操作、设置/MCP/手机配对、历史搜索、上下文/套餐额度；视口钳制与统一键盘/焦点恢复
render.ts: DOM/消息/部件/diff 渲染与过滤，命令生命周期标签与真实命令摘要、运行中输出、默认折叠（错误/拒绝展开）、手动折叠记忆；无详情禁用展开；复制/思考反馈与 model-only 过滤
clipboard.ts: copyText/copyButton 统一复制与反馈，剪贴板 API 失败时退回 DOM 复制并恢复焦点，不记录内容
todoPanel.ts: 最近 TodoWrite 推导、任务面板原生按钮与键盘展开/折叠、完成后关闭；callId 关闭集合持久化，容量 50
interaction.ts: 权限卡语义排序/预览/编号键盘/拒绝反馈/多题向导与用户输入卡；共享 InteractionDraft 和 buildPagerBar
permPreview.ts: 工具族身份分流、diff/命令/搜索/技能/MCP 预览、用户可见原因与来源徽章
quotaRings.ts: 可键盘激活的 5 小时/每周额度按钮，数据缺失隐藏；挂载 composer-status，quota-usage 驱动 update，详情由 menus 展示
icons.ts: iconEl 与 MODE_ICONS，24px 操作网格/currentColor，盾牌叹号采用 Codex 20px 原始路径；zLogoEl 保留 ZCode 品牌图片/回退
format.ts: reasoningChoices 将模型档位映射为低/中/高（最低/中间/最高，旧值就近归档），token/上下文/倒计时等展示格式化、来源标签与颜色、MCP 内容块文本还原
markdown.ts: marked 封装，流式未闭合代码块临时补闭合
i18n.ts: makeT 与中英文文案/类型，导航、输入、菜单、复制、交互卡共用
tokens.css: VSCode 字体/主题语义令牌，明暗与 HC 优先级、4px 间距和 22px 输入框圆角；语义别名在 body 计算避免主题值冻结
content.css: 消息/Markdown/代码、工具摘要、diff、权限/问答与任务进度样式；折叠和复制操作合同
styles.css: CSS 入口，导入 tokens/content；导航、一体式输入框、欢迎页、菜单/模态、思考强度横排三档与缺档禁用、模型上下文列对齐（勾选图标不分摊自动边距）、窄栏与减少动效；esbuild 合并为单文件产物

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
