/**
 * [INPUT]: 依赖 esbuild、node:fs/path；读取 src/ 与 scripts/ 源码与 media/fonts 字体
 * [OUTPUT]: 产出 out/extension.js、out/webview/*（styles.css 生产态 minify + fonts/）、out/scripts/smoke.js
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

// ---------- 静态资源 ----------
function copyStatic() {
  const cssSrc = fs.readFileSync(path.join(root, 'src/ui/webview/styles.css'), 'utf8');
  // watch 模式保留可读样式便于调试；生产模式 minify（token 表 + 组件规则的体积红利）
  if (watch) {
    fs.writeFileSync(path.join(out, 'webview/styles.css'), cssSrc);
  } else {
    const min = esbuild.transformSync(cssSrc, { loader: 'css', minify: true });
    fs.writeFileSync(path.join(out, 'webview/styles.css'), min.code);
  }
  // Inter 可变字重子集（latin/latin-ext/cyrillic/cyrillic-ext/greek，源自 Beautiful UI 同款）：
  // webview CSP 走 cspSource，随产物分发；追加子集 = 下载文件 + 在此登记
  const INTER_SUBSETS = [
    'inter-var-latin.woff2',
    'inter-var-latin-ext.woff2',
    'inter-var-cyrillic.woff2',
    'inter-var-cyrillic-ext.woff2',
    'inter-var-greek.woff2'
  ];
  fs.mkdirSync(path.join(out, 'webview/fonts'), { recursive: true });
  for (const f of INTER_SUBSETS) {
    fs.copyFileSync(path.join(root, 'media/fonts', f), path.join(out, 'webview/fonts', f));
  }
}

(async () => {
  if (watch) {
    const ctx = await esbuild.context(extension);
    const wvCtx = await esbuild.context(webview);
    copyStatic();
    await Promise.all([ctx.watch(), wvCtx.watch()]);
    console.log('[esbuild] watching...');
  } else {
    await esbuild.build(extension);
    await esbuild.build(webview);
    await esbuild.build(smoke);
    copyStatic();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
