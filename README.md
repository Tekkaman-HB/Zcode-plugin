# ZCode for VSCode

ZCode 的 VSCode 插件——在编辑器右侧栏直接使用 Z.ai 智能编程助手。

## 特性

- **与 Claude Code 并排**：注册在 Secondary Sidebar（右侧栏），与 Claude Code 扩展同级展示
- **复用桌面端账户**：直接使用 ZCode 桌面端的 OAuth 登录态（`~/.zcode/`），无需二次登录；登出/切换实时同步
- **对接 CLI 开放协议**：通过 ZCode CLI 的 `app-server` stdio 协议驱动——会话、流式输出、工具调用一应俱全
- **四种权限模式**：build / edit / plan / yolo；敏感操作弹出权限卡片——选项语义排序、编号 + 数字键直选 + 键盘导航、Edit/Write 命令级 diff 预览、拒绝可附反馈
- **AskUserQuestion 向导**：多题问卷单题翻页（已答圆点）、每题可自定义回答、选项 preview 预览；答案按问题文本回传（协议实证键位）
- **会话管理**：独立会话历史视图，点击恢复；模型（GLM-5.3 / GLM-5.3-Flash）与推理档位随时切换
- **MCP 启动进度** 与 **用量统计**（30 天 token 消耗）实时可见
- **中英双语**，跟随 VSCode 界面语言
- **全新界面**：对齐 Beautiful UI 设计系统——明暗 + 高对比四套主题令牌、Inter 可变字重、像素网格思考指示器、流式光标、胶囊按钮与多层柔影

## 环境要求

- macOS（Windows/Linux 未适配）
- 已安装 [ZCode 桌面端](https://z.ai)（默认探测 `/Applications/ZCode.app`，可用设置 `zcode.appPath` 指定）
- 桌面端已完成登录（或通过本插件的登录入口在集成终端完成 `zcode login`）

## 升级说明

如果你曾手动安装过早期开发版（publisher 为 `zcode` 的 vsix），请先卸载它再安装本插件——两个不同 ID 的扩展声明了同一个侧栏视图容器，共存会导致 ZCode 面板入口消失。命令行卸载：

```bash
code --uninstall-extension zcode.zcode-vscode
```

## 快速开始

1. 安装 `.vsix`：`code --install-extension zcode-vscode-<版本号>.vsix`
2. 打开任意文件夹，点击右侧栏的 ZCode 图标（或将 ZCode 面板拖入 Secondary Sidebar）
3. 未登录时点击「登录 Z.AI 账户」，在弹出的终端完成 OAuth
4. 发送第一条消息——首次约需 10 秒加载 MCP 服务

## 设置

| 键 | 说明 | 默认 |
|---|---|---|
| `zcode.appPath` | ZCode 桌面端安装路径 | `/Applications/ZCode.app` |
| `zcode.nodePath` | 运行 CLI 的 node 路径 | PATH 中的 node → VSCode 内置 |
| `zcode.defaultMode` | 新会话默认权限模式 | `build` |

## 开发

```bash
npm install
npm run build      # esbuild 双 target
npm run typecheck
npm run smoke      # 协议冒烟（需本机已登录 ZCode）
npm run package    # 产出 .vsix
```

按 F5 启动 Extension Development Host 调试。

## 架构

协议契约（NDJSON JSON-RPC、账户推送、反向请求、事件流）来自对 ZCode CLI 的逆向分析，记录于项目根目录的 CLAUDE.md，并由 `npm run smoke` 冒烟测试守护。

## License

MIT
