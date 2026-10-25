# scripts/
> L2 | 父级: ../CLAUDE.md

## 成员清单

smoke.ts: CLI 协议端到端冒烟，真实 spawn/认证/会话/模型与权限应答，npm run smoke
smoke-relay.ts: relay 注册/心跳实连冒烟，不执行手机配对
smoke-server.ts: zcode-server 资产启动与 hello/存活检查
bridge-harness.ts: 无手机桥接联调，配合服务端终端模拟器
preview-server.mjs: serveOnFreePort，本地静态资源服务，供界面预览/回归共用
ui-preview.mjs: 启动本地服务并打开四主题验收入口
ui-preview.html: 真实产物 iframe 容器，四主题/聊天/空态/权限/问答切换与三栏比较
ui-live.html: 加载真实 webview bundle 与 fixture，支持 theme/scene/locale/CSP 参数
ui-fixtures.js: 无网络的消息桥与 UI 场景，模拟历史/附件/引用/权限/问答/上下文等交互；服务就绪使用宿主真实值 ready，GLM 档位使用 low/high/max
theme-check.mjs: 真实产物浏览器回归，主题/窄栏/键盘/发送/附件/权限/问答/队列/滚动/复制/模态/错误与中英文；覆盖命令摘要去重/生命周期/输出/折叠、16px 权限盾牌、ready 重连、模型三档与列对齐

## 子目录

docs/: 文档结构/AI 行为检查与 ADR 建号脚本

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
