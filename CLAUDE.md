# Zcode-plugin - ZCode 的 VSCode 插件（仅 macOS）：复用桌面端账户认证，对接 CLI app-server 协议

> AI 工作规范与文档库入口见 AGENTS.md；本文件是 GEB 代码地图 L1（项目宪法）。

TypeScript + VSCode Extension API + esbuild + marked

<directory>
src/ - 扩展源码 (4子目录: protocol, ui, ui/webview, 其余为根级模块)
src/protocol/ - ZCode app-server 协议层：NDJSON JSON-RPC 客户端与全部类型契约
src/ui/ - 视图宿主：聊天视图的 WebviewViewProvider（会话历史内嵌于聊天头部时钟按钮）
src/ui/webview/ - webview 前端：应用壳(chat.ts) + 事件适配(events) + 交互队列(queue) + 菜单(menus) + 渲染/交互卡/图标/格式化/i18n/markdown
scripts/ - 冒烟测试（协议回归，`npm run smoke`）、UI 验收（`npm run ui-preview`：服务+开浏览器，四主题/三栏对比/`?theme=` 深链）与视觉级联回归（`npm run theme-check`：CSS 块序 + computed tokens 四主题互异 + dark+hc 并存 HC 胜出 + 字体子集懒加载 + 深链 + CSP 'unsafe-inline' 看守，无浏览器时降级静态断言；preview-server.mjs 为共享静态服务；ui-live.html 真实产物驱动页支持 `?csp=strict|fixed` 复现 webview CSP 环境）
media/ - 图标资源（zcode.svg=官方 Z 标复刻的侧栏图标；zcode-sessions.svg 备用；fonts/=Inter 可变字重五子集 latin/latin-ext/cyrillic/cyrillic-ext/greek）
out/ - 构建产物（esbuild 双 target + styles.css + fonts/，git 忽略）
docs/ - 项目知识库（AI 友好 Docs 标准：00-context~99-archive 十一目录；AI 工作规范入口见 AGENTS.md，与 GEB 代码地图并存——docs:check/ai:check 守护）
scripts/docs/ - 文档校验闸门脚本（check.sh 结构校验 / ai-check.sh AI 行为合同 / new-adr.sh ADR 建号）
</directory>
<config>
package.json - 插件清单：secondarySidebar 容器×1、命令、设置、市场图标（media/icon.png=官方 128px）
esbuild.js - 构建入口：extension(cjs/node) + webview(iife/browser) + smoke
tsconfig.json - 类型检查配置（noEmit，emit 由 esbuild 负责）
README.md - 面向用户的使用说明（打包进 vsix）
LICENSE - MIT
</config>

## 核心机制（逆向侦察结论，实施时勿重新推导）

- CLI 入口：`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`，`app-server --stdio` 起服务
- 必需环境变量：`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` + `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
- 账户推送暗号：`basedOnZCodeBuiltinRevision = "zcode-builtin:<revision>:<sha256hex(realpath(builtin文件))>"`，格式错则刷新被静默跳过（见 src/environment.ts:computeBuiltinRevision）
- **事件订阅门槛**：`session/create|resume` 后必须 `session/subscribe {sessionId, deliveryKind:"desktop-continuous"}`，否则收不到 `session/event` 活流（backlog 在订阅响应里回放）
- **草稿会话**：`session/create` 带 `persistence:"deferred"` 不落库不进历史，`session/send` 时服务端自动升级为 immediate——面板打开即预建会话，chips（模型/模式/思考强度）立即可用且 setMode/setModel 生效，又不污染历史
- **事件信封**：`{eventId, sessionId, turnId?, seq, type, payload:{...}}`——事件数据在 `payload` 里，不在根级
- **认证反向请求**：每次模型请求前 CLI 发 `interaction/requestProviderRuntimeHeaders`，宿主必须应答 `{headersApplied:true, requestAuth:{apiKey}}`，apiKey 来自解密 credentials.json
- **凭据解密**：`enc:v1:<b64(iv12)>.<b64(tag16)>.<b64(ct)>`（点分隔三段），key=sha256(secret)，secret=env `ZCODE_CREDENTIAL_SECRET` 或回退 `zcode-credential-fallback:<platform>:<homedir>:<username>`（见 src/credentials.ts）
- **模式命名对齐桌面端**：plan=计划模式(编辑前先出计划) / build=变更前确认(改文件前先问我) / edit=自动编辑(自动编辑文件) / yolo=完全访问(减少确认次数)
- 其余必须应答的反向请求：`session/requestRuntimePreferences`（15s 超时；`integratedTerminalShell` 是对象 `{mode:"auto"}`，不是字符串）、`interaction/requestPermission`、`interaction/requestUserInput`
- model.streaming 的 payload.kind：text_delta / reasoning_delta / tool_input_*（增量渲染管线）；tool.updated 的 payload.kind：scheduled/started/progress/result/error
- **tool.updated 不带 input（probe-diff 实证）**：scheduled/started/result 的 payload 均无 input 字段——Edit/Write 的 old_string/new_string/content 只存在于 session/read 拉回的消息部件（部件无 partId、callId 写作 callID，需归一化）。因此工具 scheduled/result 时触发 refresh-messages（400ms 节流）取真实 input 渲染 diff；Write 无 old → content 全绿显示为 new file
- **消息 id 双方言（probe-resume 实证，0.5.x 历史会话重复渲染根因）**：同一会话的消息，`session/resume` 响应 info 用 `messageId`，`session/messages` 返回 DB 方言 `info.id`（parts 同理 `messageID`，值逐条相同、键名不同）。webview 消息入 map 前必须经 events.ts:normalizeMessageId 原地归一（回填 messageId）——只归 partId/callID 不归消息 id 时，renderMessage 的 data-message-id 渲染为空串，rebuild 的查找/清理都命中不了这些"幽灵节点"，resume 快照（真 id）与权威刷新（索引 id 兜底）两套节点互删不掉，每点一次历史会话就整会话叠加一份渲染
- **model-only 注入消息（探针实证，0.5.x 提醒裸奔根因）**：服务端会向会话注入 `role:user` 的合成消息（`synthetic:true` + `info.visibility:'model-only'`，如 todo_reminder 提醒、background_task）——只给模型看，且**不带 `<system-reminder>` 标签**（文本过滤兜不住），resume/messages 两方言均携带 visibility 字段；UI 侧按 `visibility==='model-only'` 整条过滤（render.ts user 分支），勿按 source 值枚举或英文文案匹配
- **MCP 名称真相源是 `process/childProcesses`**（返回 {pid, serverName, mcpSource, pluginName}；遥测 mcpId 的 custom 段是每进程 HMAC 盐哈希无法反查名称）。`mcp/list` 只反映 workspace 池——对会话池恒报 disconnected，禁用其做 UI 状态；协议不暴露 MCP 工具名
- **用量统计已整体移除（0.5.x 用户裁决）**：齿轮菜单不展示用量行，`usage/stats` 拉取管线（fetchUsage/scheduleUsageRefresh/桥接 usage 消息/UsageRange·UsageStatsResult 类型）全链删除——勿因"桌面端有"而回加；如未来需要，重走 usage/stats + 独立 UI 载体
- **model patch 陷阱**：`state.updated` 的 `patch.model.available` 只含当前选中模型、contextWindow 是降级值（200K）——settings.model.available 必须以 create/resume 响应（配置权威：完整列表+真实窗口如 1M）为准，patch 只取 current/lastUsed，新增模型按 ref 去重追加
- **stderr 是噪声**：CLI 会向 stderr 写 dotenvx 提示/Built-in 刷新日志等诊断——严禁参与 UI 状态机（曾导致启动横幅常驻 + 会话被误清）；服务状态只由进程生命周期（spawn/exit）与推送结果驱动
- **session.updated 投影通道**：负载是宽松对象（内部投影事件 fallback），contextUsed/contextWindow/totalTokenCount/status 从这里到 UI——state.updated 不带用量
- **webview 资源缓存契约（0.5.x 实际事故：新 CSS 全部隐形）**：VSCode webview 磁盘缓存按资源 URL 命中——`out/webview/styles.css` 的 vscode-webview URI 不变，重装插件后新 CSS 永远到不了页面（症状：新 JS 逻辑生效、新样式全丢，二者"半新半旧"最难排查）。chatProvider 的 html() 给 script/styles URI 追加 `?v=<styles.css mtime>` 构建指纹，每次构建必失效；fonts 由 CSS 内相对路径引用随之失效。排障时先核对页面实际加载的 CSS（document.styleSheets 里找目标规则），勿在 DOM 逻辑层空转
- **CSP 剥 style 属性（0.5.x 实际事故：色条通条蓝 + 彩点隐形）**：CSP `style-src` 无 `'unsafe-inline'` 时，`setAttribute('style',...)` 写入的 style 属性被**静默剥离**（DOM 属性还在、渲染不生效），而 CSSOM（`el.style.left=...`）**不受 CSP 管**——症状必然"半好半坏"：上下文弹层 fill 宽度被剥→块级默认全宽通条蓝、ctx-seg/ctx-dot 背景色被剥→透明"隐形"，但弹层定位（CSSOM）完全正常。已修复：chatProvider CSP style-src 带 `'unsafe-inline'`（脚本仍被 nonce 锁死）。排查此类"内联样式不生效"先查 console 的 CSP violation 报告，勿怀疑 DOM 逻辑
- **contextUsed 正源（probe-ctx 实证）**：`session.updated` 事件 payload 带 `usage{totalTokens}`（回合中段即达，最早）+ `contextWindow`（服务端权威值如 1M）+ `contextUsageBreakdown[{source,chars}]`（真实上下文组成）；`turn.completed` payload.usage 与 `session/read` 投影、`step-finish` part 的 tokens.total 同值（60168 实测）——四路冗余。一忌：事件 payload 里没有 contextUsed 键——别等它。权威解析见 src/ui/webview/chat.ts:authoritativeWindow。**breakdown 时序洞→快照持久化**：breakdown/contextUsed 只随回合中段的 session.updated 推送（协议无拉取口，resume 旧会话/两回合之间/webview 重载后内存必然为空）；ChatApp 将 {used,win,breakdown} 快照按 sessionId 落 localStorage（chat.ts:saveCtxSnapshot/loadCtxSnapshot，session-closed 清除），session-snapshot 时恢复——弹层与圆环任何时刻可见最后一次已知值；占位行（"明细将在回合进行中自动呈现"）仅兜底从未收到过的全新会话，数据到达时 events 层 isOpenFor→toggleContextMenu(true) 自动补刷；`session/usage` 的 inputBaselineBySource 仍是按轮次 token 分桶，不可充当明细兜底
- **附件 wire 契约（probe-attach 终验）**：`zcodePromptAttachmentSchema` = `{kind:'image'|'video'|'pdf'|'file', filename, mimeType, localPath?, dataBase64?, textContent?}`——**判别键是 kind 不是 type**；**图片必须落盘走 localPath**（dataBase64 只留占位符不送达模型，probe 实证）；textContent 文本内联可用；localPath 会出现在占位符里供模型 Read。粘贴图：webview dataUrl → 宿主写 tmp 文件 → localPath；选文件：直接传原路径（不过桥 base64）。**此前 mediaType/dataUrl 形状是错误结论，勿回退**
- 事件流：`session/event` 通知 + `state.updated` 投影
- **排队/插队**：app-server 的 `session/send` 在回合运行中必拒（-32010 active prompt exists）；**sendNow 捕获 -32010 自动转排队**（busy 标志与服务器失步时的自愈——事件错过致 busy=false 但回合实际在跑，报错改入队+busy 重新置 true）；steerTurn 是 runtime 内部方法不在协议面——运行中补充输入由宿主侧排队、turn.completed/failed 后自动出队（对标桌面端 queue auto-drain）；contextUsed 仅在 ModelComplete/TurnComplete 内部事件时更新（流式期间不动是协议行为）

- **排队管理器**：排队条目带全文 + 立即发送（prioritize：stop 中止当前回合 → 该条提至队首 → turn.failed/completed 事件触发 drain 自动发出）+ 删除；queued-update 消息携带 items 全文数组供 UI 渲染
- **发送按钮供能规则**：输入框有内容（文字/附件）→ 发送态（点击=发送，运行中=入队）；输入框为空且回合运行中 → 停止态（点击=中止）。按钮状态随输入内容实时刷新（updateSendAffordance），不单看会话状态；turn.completed/failed 时投影 status 强制归位 idle

- **busy 看门狗**：15s 间隔检查——busy 超 120s 且无任何会话事件 → 强制解锁 busy、UI 归位 idle、触发排队 drain。newSession 时 busy/队列/看门狗全量复位（会话=全新生命周期，服务重启后 busy 卡死的根治）

- **工具卡交互与 diff**：折叠状态由 `.collapsed` 类驱动（body 默认显示，**禁用 `expanded+!important` 写法**——toggle 后与内联样式冲突导致关不上）；**默认一律展开**（不依赖 status 字符串判断——实测 completed 也被观察到折叠），仅用户手动折叠过的 partId（render.ts 的 userCollapsed Set）保持折叠，流式重渲染不弹开用户选择；**例外：TodoWrite 卡默认折叠**（userExpanded Set 记忆手动展开——清单由进程面板常驻展示，消息流卡仅留审计）；会话切换时 resetToolCollapseState 清空两集合；头部点击切换 + chevron 指示（chevron 旋转由 CSS transition 驱动）。Edit 工具卡 old_string/new_string → diff（red-tint 底/red 字 ↔ green-tint 底/green 字，暗色下红字 color-mix 提亮）。summary 显示文件名
- **进程面板（todoPanel.ts，对标桌面端"进程"状态面板）**：消息流与 composer 之间的常驻任务进展条——数据零副本，每次从 messages Map 反向扫描最近一次 TodoWrite 部件（isTodoWrite 判定；**扫描遇更新的 TodoWrite 调用即停**：input 已回填→显示它，未回填（tool.updated 不带 input，refresh-messages 前的窗口）→面板暂隐，绝不回显更早的旧任务——否则新任务开始后旧任务一直占位）；刷新点只有两处（rebuildMessages/scheduleFlush rAF 末尾），流式 input 到达、refresh-messages 校准、会话恢复、会话清空四路径自然覆盖；头行=状态点+计数+当前任务单行省略，展开复用 .todo-item 三态样式；**全部完成时头行右侧出现关闭按钮**（未完成不渲染）——关闭按 TodoWrite callId 记忆（chat.ts todoClosedCallId，仅同任务隐藏、新一轮任务自动重现、会话切换重置）；无清单 `.hidden` 隐藏；独立 `.todo-panel` 类不碰 `.overlay` 布局契约（theme-check 看守）
- **设计系统 = Beautiful UI（beautifului.dev）逐值移植（styles.css 唯一权威）**：oklch 令牌（page/canvas/surface/inset/hover×2/ink×3/line×3/field/accent±ink/tint/green/orange/red±tint）+ 四档圆角（chip 6 / control 8 / card 10 / window 14）+ 五档阴影（hairline/btn/card/raised/overlay，多层柔影）+ 150ms ease 缓动；**TS 切换类的 CSS 默认态与布局契约：`.overlay`（登录/空态欢迎区，chat.ts renderOverlay 以 `.visible` 切换）默认 `display:none`、显示时是 in-flow 弹性位（`flex:1`，DOM 位于 messages 与 composer 之间），空/未登录态由 TS 收起 messagesEl 让欢迎区独占；绝不可 `position:fixed`——0.5.0 两起实际事故：①漏默认态→遮罩常驻灰幕罩全板，②误用 fixed→盖住 composer 输入框不可点（theme-check 8 断言看守：默认态/折叠/命中测试）**；主题四套：亮色默认、`body.vscode-dark`、`body.vscode-high-contrast`、`body.vscode-high-contrast-light`（HC 块声明在 dark 之后，双类并存时 HC 胜出；HC 细线提档、阴影收敛为实线环），不再走 --vscode-\* 主题变量（暗色 hairline 用白 alpha 提亮防边界发软）。Inter 可变字重五子集（latin/latin-ext/cyrillic/cyrillic-ext/greek，unicode-range 与源站一致，按需懒加载；CJK 回落系统字体；追加子集 = 下载 woff2 + styles.css 补 @font-face + esbuild INTER_SUBSETS 登记）。主题四套已做级联断言（Playwright computed tokens）：四主题令牌互异、`vscode-dark+vscode-high-contrast` 并存时 HC 胜出（HC 块声明顺序保证）。动画原语：fade-up（入场，仅 `.msg:last-child` 防历史重播）/ pop-in（卡片/弹层）/ caret-blink（流式块光标，`.streaming` 类由增量更新挂、全量重建即消失）/ shimmer-text（思考标签渐变扫光）/ pixel-on（思考指示器 3×3 像素网格，计时器仅 1s 刷秒数）/ records-pulse（运行态图标）。三变体按钮（accent 主/hover-2 次/surface 幽灵）全胶囊 + `active:scale(.96)` 按压回弹；菜单行 hover 滑行 translateX(1.5px)。`prefers-reduced-motion` 全局降级。UI 验收：`npm run ui-preview`（复用 out/webview 真实产物；四主题工具条 + 欢迎页开关 + 三栏并排 + `?theme=` 深链）；`npm run theme-check` 看守切换类默认态与 composer 可点性
- **乐观渲染统一通道**：用户消息的即时显示由 controller.sendNow 受理后推 `optimistic-user`（含等长文本去重防与 message.upserted 回显双份）统一承担——首轮发送、排队出队、插队立即发送三条路径共用；webview 本地不再自行乐观渲染

- **动态思考指示器**：`.thinking-cursor` 常驻消息流底部——isBusyLike()（running/waiting/backgroundJobs 非空）任一为真即显示，盲文旋转符（10 帧/100ms）+ 实时耗时秒数；后台任务期间文案切 bgTask。**发送按钮供能同用 isBusyLike**：后台任务中空输入 = 停止态（防误判已结束）。定时器自清理（元素脱离 DOM 即 clearInterval）

- **流式增量渲染**：dirty 消息优先走 updateMessageIncrementally——文本/推理部件 textContent 直写（零 markdown 重解析、零 DOM 重建，`.raw` pre-wrap 原文模式）；新部件/工具变更才整消息重建（低频）。回合结束 refresh-messages 全量重建补 markdown。**禁用每 delta 全量 renderMessage**——O(n²) 重解析 + innerHTML 替换是一卡一卡的根因
- **diff 式 rebuild（闪烁根治，0.5.x 用户实测"文字不断闪烁"）**：refresh-messages 每次工具事件都拉全量，rebuildMessages 若全量重建则 last-child fade-up 重播 + raw↔md 视图来回切换=闪烁。三层修复：① rendered 快照 Map（id→JSON 指纹）diff 复用未变消息节点；② 回合运行中（status==='running' 且 id===currentAssistantId）的流式消息跳过重建保留 raw 增量态——messages case 的 currentAssistantId 复位改为仅 status 非 running 时执行（识别依赖）；③ 替换场景节点加 `.replaced` 类抑制 fade-up。回合结束 status 归 idle → 全部走 markdown 权威渲染一次性收敛
- **system-reminder 过滤（0.5.x 用户实测元文本裸奔）**：harness 注入给模型的 `<system-reminder>` 元文本（如 TodoWrite 空闲提醒）随消息流到达，marked 把标签吞成不可见元素致内容裸奔给用户。渲染出口整段过滤（render.ts isSystemReminderText：text 含标签即滤；user 分支与 renderPart text case 双点）——renderMessage 可返回 null，调用方（rebuildMessages/scheduleFlush）对 null 移除已有节点且 diff 链序保持在上一个可见节点；parts 非空但全被过滤不渲染空壳，parts 为空的流式空消息保留"思考中"占位。数据保留仅展示过滤
- **附件预览 lightbox**：聊天里的附件芯片可点击（`msg-attachment-btn`，链接色）→ 弹全屏预览（图片用 img，PDF/HTML 用 iframe；Esc/点背景/× 关闭）。数据源：webview 的 previewRegistry（name→dataUrl，附件入列时登记，会话切换清空）优先，回退 FilePart.url（仅 data:/https: 可显）——纯 webview 内实现，不经宿主往返
- **附件芯片渲染规则**：图片附件（mime image/* 或图片扩展名）= 26px 缩略图 + 文件名（缩略图 src 渲染期留空，渲染后 hydrateAttachmentThumbs 从 registry 回填）；文件附件 = 纯文件名（无缩略图无图标）

- **AskUserQuestion 走权限通道不走 user-input**（probe+日志实证）：工具 needsApproval → `interaction/requestPermission` → 权限卡的 modify 类选项必须携带 `modifiedInput={...input, answers:{<问题文本>:<值>}}`（$fe schema 明示 "User answers keyed by question text"；Xpa handler superRefine 校验 answers 存在且非空白，缺则 "Answers have not been collected yet" 秒失败）。UI 在权限卡内嵌问题表单（选项点选/多选勾选/自由文本），提交时合并 answers。`interaction/requestUserInput` 是另一条独立通道（pUi/CYe），CLI 在 HZa 里也会把 AskUserQuestion 权限门转成该通道下发（同 requestId）
- **用户输入 wire 契约（bundle 逆向 pUi/CYe 实证）**：`interaction/requestUserInput` params = `{requestId, sessionId, questions?:[{question, header, options:[{value,label,description?,preview?}], multiSelect?}], prompt?, toolName?, input?}`（AskUserQuestion 路径 value≡label）；应答必须 `{action:'accept'|'decline'|'cancel', content?:{answers:{...}}, reason?}`（content 为宽松 record）。**answers 键 = 问题文本**（CLI nYa 读取 `answers[questionText] ?? answer_N ?? 单题 answer`，数组值 join ", "）——此前 header 当键是错误结论，勿回退。UI 渲染 questions 数组为单题向导（见交互卡片机制）

- **交互焦点队列**：权限卡与用户输入卡统一入 `interactionOrder` 队列，tab **可点击切换**（`ixSelected` 位次，提交后原地指向下一条；`ix-tab` 是真 button），一次只渲染选中一张（tab 头 N/M = `选中/总数`）；**入队按 requestId 去重**（renderPermissionCards 里另有兜底去重）；tab 标签必须可区分：输入卡 = 首 header（多题 +N）、权限卡 = `toolName · reason 摘要`（reason 是权限请求唯一区分字段）——不用裸 toolName
- **反向请求 reannounce 机制（bundle 逆向 uRn 实证，重复卡的根因）**：CLI 对未应答的反向请求**每 1s 重发**（`reannounceIntervalMs=1000`），每次重发都是**独立 JSON-RPC 实例**（rpc.ts 各自 await 结果）。三重应对：① sessionController 应答器按 requestId 存**数组扇出**——`Map.set` 覆盖会孤儿化早到实例的 Promise（挂死 JSON-RPC 请求）；② 未答载荷留存（pendingPermissionReqs/pendingUserInputReqs），webview `ready`（重载/内存回收后 resolveWebviewView 重注入 HTML）时 `redeliverPendingInteractions()` 重投——CLI 的 reannounce 兜不住跨重载投递，否则回合永久悬挂；③ webview 桥接处理对**载荷未变**（JSON.stringify 等价）的 reannounce 跳过重渲染——否则未答期间每秒重建卡片 DOM，清掉用户正在输入的拒绝反馈/键盘选中态/焦点；权限卡反馈文字入 InteractionDraft.feedback 双保险
- **交互卡片机制（对标桌面端 PermissionDialog/ElicitationDialog，src/ui/webview/interaction.ts）**：权限卡选项按语义分类排序（allowOnce→allowAlways→denyOnce→denyAlways→custom，kind 子串判定），编号行 + 数字键直选 + ↑↓/Tab/Enter 键盘导航 + Esc=拒绝；已知选项名（full access / always allow in this project 等）本地化；allowAlways 选项内联展示 bash 放行前缀（permissionUpdates addRules + ruleContent `:*` 截尾）；拒绝类可附可选反馈（随 reason 上行，反馈行 Enter=以反馈提交拒绝）。工具身份预览（resolveToolFamily）：Edit→diff、Write→新文件全绿、execute→命令块、search（WebFetch/WebSearch）→URL、skill→名称、mcp（mcp__ 前缀）→名称+协议 reason、switchMode（ExitPlanMode）→旋转占位不渲染参数、files→文件芯片，替代裸 JSON。AskUserQuestion 权限请求：单题内嵌表单/多题翻页向导（‹ N/M › + 已答圆点，单选点选自动翻页），未答完禁止提交。用户输入卡 = 单题向导（单选点选自动推进末题即提交、每题追加自定义回答行、选项 preview 选中时 markdown 展示、Esc 返回上题/首页取消、未答题允许跳过）。subagent 来源徽章（origin.kind==='subagent'）。消息流里的 AskUserQuestion 工具卡渲染为问答摘要（render.ts，answers 缺失显示"未作答"）
- **弹层宽度与重定位（0.5.x 历史菜单暴露）**：`.popup` 带 `max-width: calc(100vw - 16px)`——长内容（单行省略的会话标题等）在窄面板下不撑破视口，靠内部 flex 收缩出省略号；**异步替换弹层内容后必须重调 positionPopup()**（renderSessionsMenu 模式）——初始 showPopup 按占位内容（"…"，~30px）定位，列表注入后宽窄已变，不重定位会把宽弹层留在旧位置溢出视口右侧
- **交互草稿与焦点**：草稿按 requestId 存 ChatApp（ixDrafts，两通道共用——CLI 的 HZa 会在两通道复用同一 requestId），无关事件重渲染不丢进度；队首切换才抢卡片焦点（ixHeadId 防重渲染偷焦点）；IME 组合期 Enter 不提交
- **AskUserQuestion 自动收卡必须关闭**：桌面端默认 `askUserQuestionAutoResolutionEnabled=true` 但靠 v4 投影的 autoResolution 倒计时 UI 兜底；插件反向请求拿不到 deadline（usr/CYe 均不带），开了会在用户作答中途静默收卡——serverManager 恒答 false（用户可用"取消"显式关闭）

法则: 极简·稳定·导航·版本精确
