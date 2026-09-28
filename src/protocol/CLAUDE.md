# src/protocol/
> L2 | 父级: ../CLAUDE.md

## 成员清单

rpc.ts: NDJSON JSON-RPC 双向客户端，行缓冲解析/pending Map/反向请求路由/进程守护，对外提供 RpcClient
types.ts: ZCode app-server 协议全部 TS 类型（方法参数/结果/23 种事件/权限/用户输入/账户快照）与 asSessionEvent/asStateUpdated 通知守卫，逆向自 zcode.cjs 0.16.9，宽进严出

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
