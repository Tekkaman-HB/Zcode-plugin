/**
 * [INPUT]: 依赖 esbuild、node:fs/path；读取 src/ 与 scripts/ 源码，合并 webview 的分层 CSS
 * [OUTPUT]: 产出 out/extension.js、out/webview/*（styles.css 分层合并 + 生产态 minify）、out/scripts/smoke.js、out/scripts/smoke-relay.js
 * [POS]: 构建脚本，双 target（node 扩展宿主 + 浏览器 webview），全项目唯一构建入口
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const out = path.join(root, 'out');
const watch = process.argv.includes('--watch');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'webview'), { recursive: true });
fs.mkdirSync(path.join(out, 'scripts'), { recursive: true });

// ---------- 扩展宿主侧（CommonJS / node18+） ----------
const extension = {
  entryPoints: [path.join(root, 'src/extension.ts')],
  bundle: true,
  outfile: path.join(out, 'extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: watch,
  logLevel: 'info'
};

// ---------- webview 侧（IIFE / browser） ----------
const webview = {
  entryPoints: [
    { in: path.join(root, 'src/ui/webview/main.ts'), out: 'main' }
  ],
  bundle: true,
  outdir: path.join(out, 'webview'),
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: watch,
  logLevel: 'info'
};

// ---------- 冒烟脚本（node 直跑，不依赖 vscode） ----------
const smoke = {
  entryPoints: [path.join(root, 'scripts/smoke.ts')],
  bundle: true,
  outfile: path.join(out, 'scripts/smoke.js'),
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: false,
  logLevel: 'info'
};

// ---------- relay 通道冒烟（真连官方 relay，只注册等待不配对） ----------
const smokeRelay = {
  entryPoints: [path.join(root, 'scripts/smoke-relay.ts')],
  bundle: true,
  outfile: path.join(out, 'scripts/smoke-relay.js'),
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: false,
  logLevel: 'info'
};

// ---------- zcode-server 资产冒烟（spawn + hello 握手 + 存活） ----------
const smokeServer = {
  entryPoints: [path.join(root, 'scripts/smoke-server.ts')],
  bundle: true,
  outfile: path.join(out, 'scripts/smoke-server.js'),
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: false,
  logLevel: 'info'
};

// ---------- 无手机全链路桥接 harness（手动联调，配合 ZCode 仓库侧终端模拟器） ----------
const bridgeHarness = {
  entryPoints: [path.join(root, 'scripts/bridge-harness.ts')],
  bundle: true,
  outfile: path.join(out, 'scripts/bridge-harness.js'),
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: false,
  logLevel: 'info'
};

// ---------- 静态资源 ----------
const styles = {
  entryPoints: [path.join(root, 'src/ui/webview/styles.css')],
  bundle: true,
  outfile: path.join(out, 'webview/styles.css'),
  minify: !watch,
  logLevel: 'info'
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(extension);
    const wvCtx = await esbuild.context(webview);
    const cssCtx = await esbuild.context(styles);
    await Promise.all([ctx.watch(), wvCtx.watch(), cssCtx.watch()]);
    console.log('[esbuild] watching...');
  } else {
    await esbuild.build(extension);
    await esbuild.build(webview);
    await esbuild.build(smoke);
    await esbuild.build(smokeRelay);
    await esbuild.build(smokeServer);
    await esbuild.build(bridgeHarness);
    await esbuild.build(styles);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
