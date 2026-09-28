# src/
> L2 | 父级: /CLAUDE.md

## 成员清单

extension.ts: 激活中枢，装配环境/服务/控制器/视图与命令，注册 provider 与配置监听
environment.ts: 环境探测层，定位 ZCode.app、node 回退链、计算内置 revision 指纹（账户推送暗号）
account.ts: 账户层，把 credentials.json/setting.json/builtin 配置翻译成 provider/updateAccountConfig 快照，监听凭据变化
credentials.ts: 凭据层，enc:v1 点分隔三段 AES-256-GCM 解密，providerId→apiKey 映射（认证反向请求的数据源）
serverManager.ts: 进程管理层，spawn app-server、推送账户、反向请求路由（含认证头应答）、重启退避
sessionController.ts: 会话控制层，会话 CRUD、desktop-continuous 订阅、事件流转发、权限/用户输入应答（reannounce 扇出 + 载荷留存重投）
i18n.ts: 扩展宿主侧文案（zh-CN/en-US，跟随 vscode.env.language）

## 子目录

protocol/: 协议层（见 protocol/CLAUDE.md）
ui/: 视图宿主层（见 ui/CLAUDE.md）

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
