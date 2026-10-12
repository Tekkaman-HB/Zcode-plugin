# src/
> L2 | 父级: /CLAUDE.md

## 成员清单

extension.ts: 激活中枢，装配环境/服务/控制器/视图与命令，注册 provider 与配置监听，globalState 持久化最近使用模式（新窗口延续，显式 defaultMode 配置优先）
environment.ts: 环境探测层，定位 ZCode.app、node 回退链、计算内置 revision 指纹（账户推送暗号）
account.ts: 账户层，把 credentials.json/setting.json/builtin 配置翻译成 provider/updateAccountConfig 快照，监听凭据变化
credentials.ts: 凭据层，enc:v1 点分隔三段 AES-256-GCM 解密，providerId→apiKey 映射（认证反向请求的数据源）
quotaUsage.ts: 套餐额度层，智谱 Coding Plan 5 小时/每周用量查询（GET open.bigmodel.cn|api.z.ai/api/monitor/usage/quota/limit，裸 Authorization 无 Bearer；unit 3=5h/6=周锚定解析）+ QuotaMonitor 5 分钟轮询（缓存秒显/失败静默），webview 圆环数据源——与已移除的 usage/stats 协议管线无关
serverManager.ts: 进程管理层，spawn app-server、推送账户、反向请求路由（含认证头应答）、重启退避
sessionController.ts: 会话控制层，会话 CRUD、desktop-continuous 订阅、事件流转发、权限/用户输入应答（reannounce 扇出 + 载荷留存重投）、排队队列（入队/删除/插队——插队 stop 后 100ms 短窗 drain 快发，800ms 去抖仅兜回合自然结束）、onModeChange 模式落定上报
i18n.ts: 扩展宿主侧文案（zh-CN/en-US，跟随 vscode.env.language）

## 子目录

protocol/: 协议层（见 protocol/CLAUDE.md）
ui/: 视图宿主层（见 ui/CLAUDE.md）

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
