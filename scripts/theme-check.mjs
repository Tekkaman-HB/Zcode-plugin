/**
 * [INPUT]: 依赖 node:fs/node:path/node:child_process + 全局 playwright（createRequire 解析）+ ./preview-server
 * [OUTPUT]: 无人值守视觉级联回归（`npm run theme-check`）：四主题令牌互异 / dark+hc 并存 HC 胜出 / 字体子集懒加载
 * [POS]: scripts/ 的断言层，与 ui-preview.mjs（人看）互补；无浏览器时降级为 CSS 块序静态断言
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { serveOnFreePort } from './preview-server.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cssPath = path.join(root, 'src/ui/webview/styles.css');
let failures = 0;
const ok = (name, pass, detail = '') => {
  console.log(`${pass ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures++;
};

// ── 静态断言（无浏览器也跑）：HC 块必须声明在 dark 之后（同特异性下后者胜出）──
function staticOrderCheck() {
  const css = fs.readFileSync(cssPath, 'utf8');
  const darkAt = css.indexOf('body.vscode-dark {');
  const hcAt = css.indexOf('body.vscode-high-contrast {');
  const hclAt = css.indexOf('body.vscode-high-contrast-light {');
  ok('CSS 块序：high-contrast 声明于 vscode-dark 之后', hcAt > darkAt && hclAt > darkAt);
}

// ── 浏览器断言：computed tokens + 字体懒加载 ──

/** 扫描 ms-playwright 缓存找可用 Chromium（headless shell 优先），避免版本错位时强制下载 */
function findCachedChromium() {
  const cache = path.join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  const candidates = [];
  for (const dir of fs.readdirSync(cache)) {
    const m = dir.match(/^(?:chromium_headless_shell|chromium|mcp-chrome)-(\d+)/);
    if (!m) continue;
    const base = path.join(cache, dir);
    const shell = fs.existsSync(path.join(base, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
      ? path.join(base, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
      : path.join(base, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    if (fs.existsSync(shell)) candidates.push({ rev: Number(m[1]), shell, headless: dir.startsWith('chromium_headless_shell') });
  }
  candidates.sort((a, b) => (b.headless - a.headless) || (b.rev - a.rev));
  return candidates[0]?.shell;
}

async function browserChecks() {
  let chromium;
  try {
    const globalRoot = execSync('npm root -g').toString().trim();
    const require = createRequire(import.meta.url);
    ({ chromium } = require(path.join(globalRoot, 'playwright')));
  } catch {
    console.log('  ⚠️ 全局 playwright 不可用，跳过浏览器断言（仅静态块序）');
    return;
  }
  const server = await serveOnFreePort(root);
  const port = server.address().port;
  const executablePath = findCachedChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 460, height: 920 } });
    await page.goto(`http://127.0.0.1:${port}/scripts/ui-preview.html`);
    const result = await page.evaluate(() => {
      const combos = [
        ['', 'light'],
        ['vscode-dark', 'dark'],
        ['vscode-high-contrast', 'hc'],
        ['vscode-high-contrast-light', 'hclight'],
        ['vscode-dark vscode-high-contrast', 'dark+hc']
      ];
      const read = () => {
        const cs = getComputedStyle(document.body);
        return ['--surface', '--ink', '--line', '--shadow-card']
          .map(k => cs.getPropertyValue(k).trim()).join('|');
      };
      const results = combos.map(([cls]) => { document.body.className = cls; return read(); });
      document.body.className = '';
      return {
        fourDistinct: new Set(results.slice(0, 4)).size === 4,
        comboEqualsHc: results[4] === results[2]
      };
    });
    ok('四主题 computed tokens 互异', result.fourDistinct);
    ok('vscode-dark + high-contrast 并存时 HC 胜出', result.comboEqualsHc);

    const fonts = await page.evaluate(async () => {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;visibility:hidden;font:600 12px Inter';
      el.textContent = 'мир Γειά café üßñ Hello 你好';
      document.body.append(el);
      await document.fonts.ready;
      const out = [
        document.fonts.check('12px Inter', 'Hello мир'),
        document.fonts.check('12px Inter', 'Γειά σου'),
        document.fonts.check('12px Inter', 'café üßñ')
      ];
      el.remove();
      return out;
    });
    ok('字体子集按需加载（latin/cyrillic/greek/latin-ext）', fonts.every(Boolean));

    // 深链参数：顶层落主题且工具条仍在
    await page.goto(`http://127.0.0.1:${port}/scripts/ui-preview.html?theme=dark`);
    const deep = await page.evaluate(() => ({
      dark: document.body.classList.contains('vscode-dark'),
      toolbarKept: !!document.getElementById('harness')
    }));
    ok('?theme= 深链落主题且保留工具条', deep.dark && deep.toolbarKept);

    // TS 切换类默认态（历史雷区：.overlay 缺 display:none 默认态 → 常驻灰幕罩全板）
    await page.goto(`http://127.0.0.1:${port}/scripts/ui-preview.html`);
    const toggles = await page.evaluate(() => {
      const overlay = document.getElementById('gate-mock');
      overlay.classList.remove('visible');
      const hiddenOk = getComputedStyle(overlay).display === 'none';
      overlay.classList.add('visible');
      const visibleOk = getComputedStyle(overlay).display !== 'none';
      // collapsed 工具卡 body 必须隐藏（折叠契约）
      const card = document.querySelector('.tool-card');
      card.classList.add('collapsed');
      const collapsedOk = getComputedStyle(card.querySelector('.tool-card-body')).display === 'none';
      card.classList.remove('collapsed');
      return { hiddenOk, visibleOk, collapsedOk };
    });
    ok('.overlay 默认隐藏、.visible 显示', toggles.hiddenOk && toggles.visibleOk);
    ok('.tool-card.collapsed 折叠 body', toggles.collapsedOk);
    // composer 可点性（0.5.0 事故：overlay 误用 fixed 盖住输入框）——隐藏 overlay 后
    // 命中测试必须直达 composer 输入框，任何全屏 fixed 层都会让这里变红
    const clickable = await page.evaluate(() => {
      const ta = document.querySelector('.composer-input');
      const r = ta.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 2));
      return el === ta || ta.contains(el) || (el && ta.contains(el.parentElement));
    });
    ok('欢迎页隐藏时 composer 输入框可命中（不被遮挡）', clickable);
  } finally {
    await browser.close();
    server.close();
  }
}

staticOrderCheck();
await browserChecks();
console.log(failures === 0 ? '── theme-check 全绿 ──' : `── theme-check 失败 ${failures} 项 ──`);
process.exit(failures === 0 ? 0 : 1);
