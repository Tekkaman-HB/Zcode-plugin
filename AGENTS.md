# AGENTS.md - Zcode-plugin

> canonical AI entry and reading router. CLAUDE.md / GEMINI.md 引用本文件；详细领域政策仍以其明确链接的唯一规范源为准。
> 本仓库遵循 docs/ 目录规范，开始任务前必须先读 docs/README.md。

## Project

ZCode 的 VSCode 插件（仅 macOS）：在编辑器右侧栏复用 ZCode 桌面端账户认证，通过 ZCode CLI 的 `app-server --stdio` 协议（NDJSON JSON-RPC）驱动 AI 会话——流式输出、工具调用、权限交互一应俱全。协议契约逆向自 `zcode.cjs`，全部结论沉淀在根 CLAUDE.md（GEB L1），实施时勿重新推导。

## Tech Stack

TypeScript 5.7（strict + noUnusedLocals）+ VSCode Extension API（^1.95.0）+ esbuild 0.24（双 target：node 扩展宿主 / browser webview）+ marked 15。运行时依赖仅 marked 一个。

## Commands

```bash
npm run build        # esbuild 双 target 产出 out/
npm run typecheck    # tsc --noEmit（strict）
npm run smoke        # 协议冒烟（需本机 ZCode 桌面端已登录，真实模型调用）
npm run ui-preview   # UI 验收（四主题/三栏对比，开浏览器）
npm run theme-check  # 视觉级联回归（8 断言，无浏览器降级静态）
npm run package      # 产出 .vsix
npm run docs:check   # 文档结构校验
npm run ai:check     # AI 行为合同校验
```

## 交付节奏（用户裁决的固定流程）

每次功能/修复完成并验证后：升 package.json 版本号（patch +1）→ `npm run package` → `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension <vsix 路径>` → 提示用户在 VSCode 里 Reload Window（重载会杀掉扩展宿主即当前对话本体，AI 绝不可用脚本代按，只能提示用户手动点）。

## Constraints

硬约束全文见 docs/00-context/硬约束.md。要点：

- 仅支持 macOS；CLI 入口 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`，可用 `zcode.appPath` 覆盖。
- 协议知识是逆向实证结论，以根 CLAUDE.md 为唯一事实源（事件订阅门槛、附件落盘、patch 陷阱、stderr 噪声禁令等），修改协议相关代码前必读。
- 模块隔离：webview 层禁止 import vscode；宿主层禁止 import src/ui/webview 内部模块；protocol 层禁止反向依赖 ui；bridge.ts 保持纯类型。
- 单文件 ≤800 行，超出即重构契机；风格遵循现有代码（中文注释 + ASCII 分块）。
- 凭据解密结果仅用于应答 CLI 认证反向请求，严禁日志/上报。
- 未经用户明确授权，所有搜索、扫描、抽样和链接核查都显式排除 `docs/60-marketing/`、`docs/70-research/`、`docs/99-archive/`，不得读取其中任何文件内容。
- `docs/60-marketing/`、`docs/70-research/` 未经用户明确授权，不读取、不创建、不修改、不移动、不重命名、不删除其中任何文件。
- `docs/99-archive/` 默认不读取、不维护；用户确认 50/80 收敛清单后，仅可读取本次移动所需的归档说明和目标位置，并移动清单中的源文件，不得浏览或整理无关归档。
- 完成 `docs/50-planning/` 或 `docs/80-dev/` 中记录的方案或阶段时，主动判断是否可收敛；先列出完成证据、已验证事实、10/20/30/40 目标、冲突和拟移动源文件，等待用户确认后再更新事实并移动到 99。
- 50/80 日期前缀文件的本地最后修改时间超过 7 天时，轻量提醒用户考虑收敛；不维护复杂提醒状态。

## Behavior（AI 编码行为准则）

四律约束所有写、改、审代码的任务；详细展开与自检项见 `docs/30-engineering/AI编码指南.md` 的「行为准则」。

1. **先想后写**：动手前显式陈述假设与方案取舍；存在多种解释时不静默二选一；有更简单的做法要直说；不清楚就问，不猜。
2. **简单优先**：只写当前问题需要的代码；不做投机抽象、未要求的灵活性与可配置性；不为不可能的场景写错误处理；能 50 行解决就不写 200 行。
3. **外科手术式修改**：只改与任务直接相关的代码；不顺手“改进”邻近代码、注释或格式；匹配既有风格；只清理本次改动产生的孤儿代码；每一行改动都必须能追溯到本次请求。
4. **目标驱动验证**：动手前把任务转成可验证的成功标准（修 bug 先写复现用例）；多步任务先列计划并给每步一个验证点；验证不通过不交付。

## Security

- 解密后的 apiKey 只在 `interaction/requestProviderRuntimeHeaders` 应答中使用，绝不进日志、遥测或错误消息。
- webview HTML 使用 CSP（nonce 脚本 + cspSource 资源域）；附件预览仅放行 data:/https:。
- 凭据文件 `~/.zcode/v2/credentials.json` 只读；密钥环境变量只放 `.env`（已 gitignore），模板见 `.env.example`。

## Read First

docs/README.md 的固定读取顺序：AGENTS.md → 00-context/硬约束.md → 00-context/项目简介.md → 20-architecture/架构概览.md → 30-engineering/命令清单.md → 30-engineering/AI编码指南.md。

> 本仓库同时维护 GEB 分形文档体系（根/目录 CLAUDE.md 三层代码地图，L3 文件头 INPUT/OUTPUT/POS）：AGENTS.md 管 AI 工作规范与知识库路由，CLAUDE.md 管代码结构地图——两套并存、职责不重叠；改代码必须走 GEB 回环（更新 L3 头部与所在目录 CLAUDE.md）。
