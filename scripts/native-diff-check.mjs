/**
 * [INPUT]: esbuild、真实 VSCode、全局 Playwright；native-diff-test 的临时原生扩展测试窗口
 * [OUTPUT]: 隔离用户配置/扩展的原生 diff 验收与 .playwright-mcp/native-session-diff.png 截图
 * [POS]: scripts/ 的 VSCode 集成验收驱动，不重载用户窗口、不启动 ZCode CLI
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = process.cwd(), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-native-diff-'));
const app = '/Applications/Visual Studio Code.app';
const executable = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
const code = path.join(app, 'Contents/MacOS', executable);
let child, browser;
try {
  for (const name of ['extension', 'workspace', 'extensions', 'profile/User']) await fs.mkdir(path.join(temp, name), { recursive: true });
  await fs.writeFile(path.join(temp, 'extension/package.json'), JSON.stringify({ name: 'zcode-diff-test-host', version: '1.0.0', publisher: 'local', engines: { vscode: '^1.95.0' }, main: './main.js', activationEvents: [] }));
  await fs.writeFile(path.join(temp, 'extension/main.js'), 'exports.activate = () => {};');
  await fs.writeFile(path.join(temp, 'profile/User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'diffEditor.renderSideBySide': true, 'workbench.editor.enablePreview': false }));
  const test = path.join(temp, 'native-tests.cjs');
  await build({ entryPoints: ['scripts/native-diff-test.ts'], bundle: true, outfile: test, platform: 'node', format: 'cjs', external: ['vscode'] });
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const env = { ...process.env, ZCODE_DIFF_TEST_ROOT: temp };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VSCODE_IPC_HOOK_CLI;
  child = spawn(code, ['--new-window', '--wait', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--user-data-dir', path.join(temp, 'profile'), '--extensions-dir', path.join(temp, 'extensions'),
    '--extensionDevelopmentPath', path.join(temp, 'extension'), '--extensionTestsPath', test,
    '--remote-debugging-port=' + port, path.join(temp, 'workspace')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  console.log('Starting isolated VSCode diff integration window…');
  const deadline = Date.now() + 60_000;
  let ready;
  while (Date.now() < deadline) {
    try { ready = JSON.parse(await fs.readFile(path.join(temp, 'ready.json'), 'utf8')); break; } catch {}
    try { throw new Error(await fs.readFile(path.join(temp, 'failure.txt'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (child.exitCode !== null) throw new Error('VSCode exited before tests: ' + output.slice(-3000));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('VSCode startup timed out: ' + output.slice(-3000));
  const { chromium } = createRequire(import.meta.url)('/opt/homebrew/lib/node_modules/playwright');
  console.log('Native API checks: ' + JSON.stringify(ready));
  try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); }
  catch (error) { console.error(output.slice(-3000)); throw error; }
  const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('workbench'));
  if (!page) throw new Error('Native workbench renderer not found');
  await page.waitForFunction(() => [...document.querySelectorAll('.view-line')].some(el => el.textContent.includes('session_after_marker')), undefined, { timeout: 15_000 });
  const visible = await page.evaluate(() => ({
    multi: [...document.querySelectorAll('[class]')].some(el => [...el.classList].some(name => /multi.?diff/i.test(name))),
    before: [...document.querySelectorAll('.view-line')].some(el => el.textContent.includes('session_before_marker')),
    after: [...document.querySelectorAll('.view-line')].some(el => el.textContent.includes('session_after_marker')),
    inserted: document.querySelectorAll('.line-insert, .char-insert').length,
    deleted: document.querySelectorAll('.line-delete, .char-delete').length
  }));
  await fs.mkdir(path.join(root, '.playwright-mcp'), { recursive: true });
  await page.screenshot({ path: path.join(root, '.playwright-mcp/native-session-diff.png') });
  if (!visible.multi || !visible.before || !visible.after || !visible.inserted || !visible.deleted) throw new Error('Native diff content did not render: ' + JSON.stringify(visible));
  console.log(JSON.stringify({ ...ready, rendered: visible }));
  await fs.writeFile(path.join(temp, 'continue'), 'ok');
  await browser.close(); browser = undefined;
  const exitCode = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(-1), 15_000))]);
  if (exitCode !== 0) throw new Error('VSCode tests failed: ' + output.slice(-3000));
  console.log('Native session diff checks passed');
} finally {
  await fs.writeFile(path.join(temp, 'continue'), 'stop').catch(() => {});
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) child.kill();
  await fs.rm(temp, { recursive: true, force: true });
}
