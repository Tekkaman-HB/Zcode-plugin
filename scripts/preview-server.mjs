/**
 * [INPUT]: 依赖 node:http/node:fs/node:path；读取项目根静态文件
 * [OUTPUT]: 对外提供 serveOnFreePort(root, base)——ui-preview.mjs 与 theme-check.mjs 共用的静态服务
 * [POS]: scripts/ 的验收基础设施，与浏览器/断言解耦
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

/** 项目根为站点根（/out/webview/* 与 /scripts/* 均可达）；从 base 端口起找空闲位 */
export function serveOnFreePort(root, base = 8917) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(root, urlPath === '/' ? 'scripts/ui-preview.html' : urlPath);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  }).then(s => s); // listen(0) 由系统分配空闲端口，天然防互抢
}
