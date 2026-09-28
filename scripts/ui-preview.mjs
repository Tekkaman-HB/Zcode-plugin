/**
 * [INPUT]: 依赖 ./preview-server 的 serveOnFreePort + node:child_process；读取项目根（out/webview 真实产物 + scripts/ui-preview.html）
 * [OUTPUT]: 启动静态服务并打开浏览器（`npm run ui-preview`）——UI 视觉验收入口
 * [POS]: scripts/ 的验收工具，与 smoke.ts（协议回归）、theme-check.mjs（级联回归）并列
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { exec } from 'node:child_process';
import path from 'node:path';
import { serveOnFreePort } from './preview-server.mjs';

const root = path.resolve(import.meta.dirname, '..');

const server = await serveOnFreePort(root);
const url = `http://127.0.0.1:${server.address().port}/scripts/ui-preview.html`;
console.log(`[ui-preview] ${url}`);
console.log('[ui-preview] 工具条切四主题；「并排对比」三栏横比；?theme=dark 深链直达。Ctrl+C 退出');

// 仅 macOS（本插件宿主平台即 darwin）
if (process.platform === 'darwin') exec(`open "${url}"`);
else if (process.platform === 'linux') exec(`xdg-open "${url}" 2>/dev/null`);

process.on('SIGINT', () => {
  server.close();
  console.log('[ui-preview] bye');
  process.exit(0);
});
