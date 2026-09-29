---
status: current
owner: Dev Team
last-reviewed: 2026-09-28
---

# Docs Index

## Project

ZCode 的 VSCode 插件（仅 macOS）：复用桌面端账户认证，对接 ZCode CLI app-server 协议驱动 AI 会话。

## Current Phase

- 当前阶段：0.5.x——核心会话/权限/附件链路已稳定，webview 已模块化拆分
- 当前重点：协议契约守护（smoke）与 UI 验收（theme-check/ui-preview）常态化
- 当前禁止：修改协议层前不读根 CLAUDE.md 的逆向结论；webview 引入 vscode 依赖；向日志输出解密凭据

## Read First（AI 与新人按此顺序，不得跳读）

1. AGENTS.md
2. docs/00-context/硬约束.md
3. docs/00-context/项目简介.md
4. docs/20-architecture/架构概览.md
5. docs/30-engineering/命令清单.md
6. docs/30-engineering/AI编码指南.md

> 代码结构地图见根 CLAUDE.md（GEB L1）与各目录 CLAUDE.md（L2）——docs/ 是项目知识库，CLAUDE.md 是代码地形图，两套并存。

## Directory Map

见各目录的 README.md；创建或更新非保护目录文档前必须先读目标目录的命名格式、内容格式和编写要求。

## 保护目录

- `60-marketing/`、`70-research/`、`99-archive/`：除非用户明确要求或授权，本仓库所有脚本、命令、AI 指令和自动检查都必须显式排除这些目录，不得主动读取其中任何文件内容；结构检查只允许确认约定路径存在。
- `60-marketing/`、`70-research/`：未经用户明确授权，不读取内容，不执行创建、修改、移动、重命名或删除。
- `99-archive/`：日常任务不读取、不处理；用户确认收敛清单后，仅授权读取本次移动所需的说明和目标位置并新增清单内归档，已有归档文件不得自动更新。
- 自动检查只确认上述路径是否存在，不打开文件内容。

## 文档收敛

- 实施完成时：主动判断 `50-planning/` 或 `80-dev/` 中对应方案/阶段是否可收敛。
- 确认前：列出完成证据、待收敛事实、拟更新或新建的 10/20/30/40 文件、冲突，以及拟移动到 99 的源文件；没有新事实时标注“仅归档”。
- 用户确认后：按目标目录 README 更新事实，并把清单中的源文件移动到 `99-archive/`。确认只覆盖清单范围，执行中新发现项跳过并报告。
- 定期提醒只使用一个简单规则：50/80 日期前缀文件的本地最后修改时间超过 7 天即提醒考虑收敛。
