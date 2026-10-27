# src/ui/webview/
> L2 | 父级: ../CLAUDE.md

## 成员清单

main.ts: acquireVsCodeApi 装配与消息监听，挂载 ChatApp
changes.ts: renderChangeSummary，输入框上方的当前会话文件数/增删行数与查看入口，准备中扫光反馈、手动关闭后在面板存活期间按会话保持收起并恢复输入焦点、无可审查记录时隐藏摘要与入口，部分记录标注范围；二进制不计行数
chat.ts: 按原 URL 接收附件预览并在消息重建后回填缩略图；ChatApp 共享状态与桥接入口，事件适配/交互队列/菜单/输入/模态的 Host 实现；消息 id/parts 归一、快照 diff、分块流式 Markdown/工具指纹复用与滚动跟随；状态/消息/交互变动校准首响等待，完成消息退出流式复用以显示固定思考用时，消息变化同步空态；按会话 id 过滤 diff 迟到消息，切换时清空旧摘要；仅 ready 允许发送
shell.ts: 无本地模式状态行，套餐/上下文圆环同排的输入底栏；展示骨架与刷新、变更摘要关闭按钮，服务加载文字扫光、导航/欢迎页/一体式 composer、模型标签、语义权限图标和上下文圆环；renderStatus 更新控件，renderResponseWait 按运行态/服务就绪/未答交互判断首响等待，消息增量仅校准等待占位
composer.ts: ComposerController 输入层，IME/Enter/Shift+Enter、附件粘贴/移除、@ 文件浏览与 slash 选择、发送/停止、排队展示和按原 URL 回填缩略图（无 URL 的乐观消息按文件名匹配）；状态仍由 ChatApp 持有
panels.ts: PanelsController 模态层，配对启动文字扫光、等待扫码静态提示；按原 URL 查找附件 lightbox 图片，避免同名串图，与手机配对展示；Esc/背景关闭、Tab 焦点约束、触发焦点恢复、配对刷新保留焦点与二维码
events.ts: session/event 适配，ChatSessionState/MutableSessionMessage/EventHost 与消息 id/工具结果归一；保持 optimistic-user 与权威回显合并
queue.ts: 权限/问答统一焦点队列，requestId 去重、交互 tab 与草稿保持、一次展示一张与应答推进
menus.ts: MCP 未连接红灯置顶、远程未知灰灯与状态文案；加载状态与运行会话标题文字扫光；MenuController 唯一 popup 实现，模型与横排低/中/高思考强度（原始档位发送、缺档禁用、左右键导航）、四种语义权限图标/完全访问警示色、附件、聊天操作、设置/MCP/手机配对、历史搜索、上下文/套餐额度；视口钳制与统一键盘/焦点恢复
render.ts: 附件缩略图携原 URL，等待加载或失效时隐藏；DOM/消息/部件/diff 渲染与过滤；按消息 time.created/completed 将思考落档为固定用时，缺时间保留普通摘要；纯工具消息使用紧凑活动行，空文本/回合边界不占位，读取/编辑/搜索/技能按 Codex 语义选图标；processingLabel 为处理状态共用的文字扫光，负延迟按页面时间续播，无旋转图形/秒表/JS 定时器；工具活动分组/指纹/折叠记忆；updateStreamingText 保留完成块、仅解析尾块；renderPendingResponse 以最后有效消息派生首响等待，节点跨消息校准复用且不入会话消息；复制/思考反馈与 model-only 过滤
clipboard.ts: copyText/copyButton 统一复制与反馈，剪贴板 API 失败时退回 DOM 复制并恢复焦点，不记录内容
todoPanel.ts: 当前任务文字扫光与静态状态点，最近 TodoWrite 推导、任务面板原生按钮与键盘展开/折叠、完成后关闭；callId 关闭集合持久化，容量 50
interaction.ts: 模式切换等待批准静态提示；权限卡语义排序/预览/编号键盘/拒绝反馈/多题向导与用户输入卡；共享 InteractionDraft 和 buildPagerBar
permPreview.ts: 工具族身份分流、diff/命令/搜索/技能/MCP 预览、用户可见原因与来源徽章
quotaRings.ts: 可键盘激活的 5 小时/每周额度按钮，数据缺失隐藏；挂载 composer-bar-right，与上下文圆环同行，16px 图形/24px 占位，统一间距，quota-usage 驱动 update，详情由 menus 展示
icons.ts: iconEl 与 MODE_ICONS 图标名称映射，计划文档/请求批准手掌/自动编辑终端盾牌/完全访问叹号盾牌；后三者采用 Codex 20px 路径；终端/编辑/搜索采用 Codex 16px 原始路径，通用工具/技能/MCP 用同款扳手，其余操作用 24px 网格/currentColor；zLogoEl 保留 ZCode 品牌
format.ts: formatElapsedTime 按服务端消息起止毫秒生成固定 s/m+s 用时，缺失/无效时间返回 null；reasoningChoices 将模型档位映射为低/中/高（最低/中间/最高，旧值就近归档），token/上下文/倒计时等展示格式化、来源标签与颜色、MCP 内容块文本还原
markdown.ts: marked 封装，renderMarkdown 为未闭合代码块临时补闭合；splitStreamingMarkdown 用词法块边界区分完整前缀与待定尾块
i18n.ts: makeT 与中英文文案/类型，导航、输入、菜单、复制、交互卡与关闭变更摘要共用
tokens.css: VSCode 字体/主题语义令牌，明暗与 HC 优先级、4px 间距和 22px 输入框圆角；语义别名在 body 计算避免主题值冻结
content.css: 消息/Markdown 段落节奏与相对代码字号、思考摘要/展开正文及代码统一弱色与完成分隔线、居中思考箭头、24px 工具活动行/工具收尾消息 4px 段距/纯工具消息零外边距/末条工具与复制同排/命令摘要与状态标签共用弱色（标题栏展开与收起均保持完整 8px 圆角）、diff、权限/问答与任务进度样式（14px 细圈，进行中 4px 中心点、待处理空心、完成绿勾）；折叠和复制操作合同
styles.css: 套餐/上下文圆环同排等高居中与窄栏统一间距，无本地模式空行；processing 统一文字扫光，减少动态效果/强制颜色下静态回退；CSS 入口，导入 tokens/content；变更摘要查看/关闭操作成组；导航/输入框/欢迎页/菜单/模态；权限菜单 20px 图标和 16px 勾选整行居中、8px 图文间距与警示配色；模型上下文列对齐、思考强度三档、窄栏与减少动效；esbuild 合并为单文件产物

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
