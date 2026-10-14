# src/
> L2 | 父级: /CLAUDE.md

## 成员清单

extension.ts: 激活中枢，装配环境/服务/控制器/视图与命令，注册 provider 与配置监听，globalState 持久化最近使用模式（新窗口延续，显式 defaultMode 配置优先）；装配 PairingController（常驻 subscriptions + autoRestore 持久化配对自动重连 + zcode.pairPhone 命令 + 工作区/会话快照变化通知手机端）
environment.ts: 环境探测层，定位 ZCode.app、node 回退链、计算内置 revision 指纹（账户推送暗号）
account.ts: 账户层，把 credentials.json/setting.json/builtin 配置翻译成 provider/updateAccountConfig 快照，监听凭据变化
credentials.ts: 凭据层，enc:v1 点分隔三段 AES-256-GCM 解密，providerId→apiKey 映射（认证反向请求的数据源）；readDesktopRelayIdentity 读桌面端 relay 设备身份三件套（deviceMid/deviceSid/passHash——手机配对复用桌面身份）
quotaUsage.ts: 套餐额度层，智谱 Coding Plan 5 小时/每周用量查询（GET open.bigmodel.cn|api.z.ai/api/monitor/usage/quota/limit，裸 Authorization 无 Bearer；unit 3=5h/6=周锚定解析）；key 三源解析——account: 套餐 provider 走凭据、个人 provider（bigmodel-api/zai-api 模板）走 provider_config.json（templateId 含 zai 路由 api.z.ai 否则 open.bigmodel.cn）、未指定 rank 兜底；无周限额套餐 weekly=null 前端自适应单环。QuotaMonitor 5 分钟轮询（显式触发绕节流、飞行中合并补跑；缓存秒显/失败静默），webview 圆环数据源——与已移除的 usage/stats 协议管线无关
pairingController.ts: 手机配对控制层（vscode 胶水）——持有 PairingManager、二维码 SVG 生成（qrcode）、zcode-server 资产定位（配置 zcode.serverPath → 默认 ~/.zcode/vscode-remote/zcode-server.cjs）与拉起 env、globalState 身份持久化、autoRestore 常驻自动重连、状态→webview pair-status 推送
serverManager.ts: 进程管理层，spawn app-server、推送账户、反向请求路由（含认证头应答）、重启退避、logInteraction 交互诊断出口（OutputChannel "Zcode Protocol"，交互收包/应答/撤回一行式留痕——排障定案用）
sessionController.ts: 会话控制层，会话 CRUD、desktop-continuous 订阅、事件流转发、权限/用户输入应答（reannounce 扇出 + 载荷留存重投；对已失效请求的应答显式回执 error 提示）、排队队列（入队/删除/插队——插队 stop 后 100ms 短窗 drain 快发，800ms 去抖仅兜回合自然结束）、onModeChange 模式落定上报、setMode 受理后主动回推 webview state-updated patch `{mode:{current}}`（模式芯片即时归位，不依赖 CLI 广播——实测 CLI 受理 mode.updated 而 UI 滞后）、dropPendingInteractions 撤回时回发 interactions-dropped 清 webview 交互卡（stop() 会自动 decline 未答交互——计划审批卡被 stop 连带拒绝曾致 "Permission denied for ExitPlanMode"）；手机端任务快照（mobileTasks 缓存 + refreshMobileTaskSnapshot 翻译 session/list，回合结束/新建时刷新经 onSnapshotChanged 推手机）
i18n.ts: 扩展宿主侧文案（zh-CN/en-US，跟随 vscode.env.language）

## 子目录

protocol/: 协议层（见 protocol/CLAUDE.md）
remote/: 手机远控协议层（见 remote/CLAUDE.md）
ui/: 视图宿主层（见 ui/CLAUDE.md）

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
