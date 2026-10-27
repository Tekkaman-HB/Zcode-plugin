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
ui-fixtures.js: 无网络的消息桥与 UI 场景，模拟历史/附件/引用/权限/问答/上下文等交互；可委托 __saveImage 接入真实宿主落盘；服务就绪使用宿主真实值 ready，GLM 档位使用 low/high/max
tool-activity-check.mjs: theme-check 子模块；跨消息工具行 24px 连续排布、空文本/回合边界零占位、流式正文接管及 Codex 终端/铅笔/搜索/扳手语义与尺寸
loading-check.mjs: theme-check 子模块；真实产物中复现推理夹杂工具刷新，验证扫光续播/无秒表定时器或旋转、思考结束固定用时/历史恢复/缺失时间降级/展开文字同色，四主题/减少动态效果/强制颜色及最终静态状态
mcp-check.mjs: theme-check 子模块；真实控制器清单/进程合并与去重、忽略 workspace 状态，以及四主题红绿灯/未连接置顶/全失败与恢复刷新
composer-check.mjs: theme-check 子模块；验证变更摘要关闭/输入焦点恢复/按会话隔离/刷新保持/四主题窄栏；真实宿主落盘连接 webview，覆盖中英文连续粘贴后的发送解锁、缩略图、原始名称、文件内容与路径载荷；历史本地图片/实时消息回流、同名图片隔离、停止/自然结束后的 artifact 图片（删除临时源后重载仍可预览）、已删除图片隐藏和选文件后的点击预览
theme-check.mjs: 验证套餐/上下文圆环同排几何、16px 尺寸与统一间距，单/双环/无数据收起及键盘明细；调用 loadingChecks/toolActivityChecks/mcpChecks/composerChecks 并执行真实产物浏览器回归，首响前立即展示/消息校准/推理和正文接管/终止与交互清理/运行会话恢复，以及主题/窄栏/键盘/发送/附件/权限/队列/滚动/复制/模态；覆盖无 diff 记录时摘要与入口隐藏、部分记录审查、语义图标/居中/警示色、段距、工具分组、流式稳定 DOM、ready 重连与模型三档
git-changes-check.mjs: 私有快照+实际 Git 临时仓库与控制器/原生多文件 diff 桩回归；覆盖原有脏改动排除、多轮/切换/检查点中断恢复、外部保存/冲突/断档、发送/队列等待、迟到事件归属、项目 Git 零写入和路径边界、快照持久只读/二进制/缺失错误
native-diff-test.ts: 独立 Extension Development Host 入口；真实 VSCode API 验证会话多文件标签、前后原文与资源只读、侧栏释放/文件系统重新注册
native-diff-check.mjs: diff-smoke 驱动；隔离 VSCode 配置与扩展目录，启动测试入口，Playwright 检查原生 diff 红绿行与截图，无账户/模型请求

## 子目录

docs/: 文档结构/AI 行为检查与 ADR 建号脚本

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
