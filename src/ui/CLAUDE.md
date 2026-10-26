# src/ui/
> L2 | 父级: ../CLAUDE.md

## 成员清单

bridge.ts: attachment-preview 以原 URL 回填本地图片数据；扩展↔webview 纯类型消息契约（McpServerEntry：可选 pid，connected true/false/null 区分连接/未连接/未知）（SessionChangesPayload/session-changes/review-changes；携带会话 id、ready/missing/partial/error 完整性状态和 preparing 暂态；interactions-dropped 清交互卡）
gitChanges.ts: SnapshotStore 私有 Git 对象库；原项目只读列路径，私有独立索引/对象捕获文件、计算差异和三方合并、读取原始字节/大小，排除保护目录/gitignore，无过滤器/外部 diff，不写项目 Git
sessionChanges.ts: SessionChanges 会话差异唯一状态源；按工作区+会话持久化，实际发送前基线/工具检查点/实时结束事件归属，中间检查点落盘供中断恢复；多轮合并，外部保存/重叠/冲突/断档标部分或不可用，旧会话不回退 HEAD
changeReview.ts: 原生多文件 diff 展示适配；订阅 SessionChanges 推送摘要，vscode.changes 一次打开当前会话全部文件；随侧栏释放订阅
snapshotDocuments.ts: 扩展生命周期的只读 FileSystemProvider；工作区键/blob URI 从私有对象库读取文本或二进制，侧栏释放/重新注册后仍可恢复，缺失资源显式报错
chatProvider.ts: 聊天视图宿主（WebviewViewProvider），HTML/CSP 生成（style-src 'unsafe-inline' 必需——CSP 静默剥离 setAttribute 的 style 属性，详见 L1"CSP 剥 style 属性"条目；body[data-logo] 注入官方原图 URI——webview 禁 import vscode，asWebviewUri 只能宿主完成）、桥接消息分发到 SessionController；粘贴图回包保留原请求名称以清理前端等待状态，磁盘路径独立清理校验；选择图片携带 data URL，历史/消息刷新/实时附件按原 URL 异步读取本地或 zcode-artifact 图片回填预览（artifact 从 CLI 会话附件目录读取已保存的 data URL，不回退可能被覆盖的原临时路径），每个快照去重，限制 50MiB 并排除保护目录，缺失文件不阻断消息

## 子目录

webview/: ChatApp 共享状态与 shell/composer/panels 展示交互、events/queue/menus/render、分层主题 CSS（见 webview/CLAUDE.md）

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
