/**
 * [INPUT]: node:fs/path/child_process、全局 playwright、./preview-server 与真实 out/webview 产物
 * [OUTPUT]: 真实产物 UI 回归；覆盖四主题/窄栏/键盘/发送/权限、命令状态与输出/折叠记忆、16px 权限盾牌与模型三档
 * [POS]: scripts/ 的自动界面验收层，与 ui-preview.mjs 共用 ui-live.html 场景，无 CLI 或网络请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { serveOnFreePort } from './preview-server.mjs';

const root = path.resolve(import.meta.dirname, '..');
let failures = 0;
let passed = 0;
const ok = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (pass) passed++; else failures++;
};
const tokens = fs.readFileSync(path.join(root, 'src/ui/webview/tokens.css'), 'utf8');
const darkAt = tokens.indexOf('body.vscode-dark {');
ok('HC 令牌位于 dark 之后', darkAt >= 0 && tokens.indexOf('body.vscode-high-contrast {') > darkAt && tokens.indexOf('body.vscode-high-contrast-light {') > darkAt);
const provider = fs.readFileSync(path.join(root, 'src/ui/chatProvider.ts'), 'utf8');
ok("CSP 保留 style-src 'unsafe-inline' 和脚本 nonce", /style-src[^;]*'unsafe-inline'/.test(provider) && /script-src 'nonce-/.test(provider));
ok('字体跟随 VSCode，不加载 Inter', tokens.includes('--vscode-font-family') && tokens.includes('--vscode-editor-font-family') && !fs.readFileSync(path.join(root, 'out/webview/styles.css'), 'utf8').includes('@font-face'));

function findChromium() {
  const cache = path.join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  for (const dir of fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : []) {
    for (const relative of ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium']) {
      const file = path.join(cache, dir, relative);
      if (fs.existsSync(file)) return file;
    }
  }
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return fs.existsSync(chrome) ? chrome : undefined;
}

async function browserChecks() {
  const require = createRequire(import.meta.url);
  let chromium;
  try { ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))); }
  catch { console.log('  ⚠️ 无全局 playwright；本次仅完成静态检查，未完成交互验收'); return; }
  const server = await serveOnFreePort(root);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: findChromium(), headless: true });
    const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
    page.setDefaultTimeout(4000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copied = text; } } });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const load = async (query = '') => {
      await page.goto(base + '/scripts/ui-live.html?harness=0' + query);
      await page.waitForSelector('.model-label');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const check = async (name, fn) => {
      try { ok(name, await fn()); } catch (e) { ok(name, false, e.message.split('\n')[0]); }
    };
    const lastSent = kind => page.evaluate(kind => window.__sent.filter(m => m.kind === kind).at(-1), kind);
    await check('四主题互异，dark+HC 并存时 HC 胜出', async () => {
      await load();
      return page.evaluate(() => {
        const read = () => ['--surface', '--ink', '--line', '--shadow-overlay'].map(k => getComputedStyle(document.body).getPropertyValue(k)).join('|');
        const results = ['', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light', 'vscode-dark vscode-high-contrast'].map(cls => { document.body.className = cls; return read(); });
        return new Set(results.slice(0, 4)).size === 4 && results[2] === results[4];
      });
    });
    await check('主题颜色与字体服从宿主变量', async () => {
      await load();
      return page.evaluate(() => {
        document.documentElement.style.setProperty('--vscode-sideBar-background', '#123456');
        document.documentElement.style.setProperty('--vscode-font-family', 'monospace');
        const style = getComputedStyle(document.body);
        return style.backgroundColor === 'rgb(18, 52, 86)' && style.fontFamily === 'monospace';
      });
    });
    await check('四主题 × 260/320/460/900px 无横向溢出，菜单位于视口内且模型上下文列对齐', async () => {
      for (const theme of ['light', 'dark', 'hc', 'hclight']) {
        await load('&theme=' + theme);
        for (const width of [260, 320, 460, 900]) {
          await page.setViewportSize({ width, height: 900 });
          await page.locator('.model-chip').click();
          const good = await page.evaluate(() => {
            const popup = document.querySelector('.popup').getBoundingClientRect();
            const composer = document.querySelector('.composer-surface').getBoundingClientRect();
            const send = document.querySelector('.send-btn').getBoundingClientRect();
            const metaEdges = [...document.querySelectorAll('.model-item .menu-item-meta')].map(el => el.getBoundingClientRect().right);
            return metaEdges.every(right => Math.abs(right - metaEdges[0]) < 1)
              && document.documentElement.scrollWidth <= innerWidth && popup.left >= 0 && popup.right <= innerWidth + 1 && send.right <= composer.right && composer.right <= innerWidth;
          });
          await page.keyboard.press('Escape');
          if (!good) return false;
        }
      }
      return true;
    });
    await page.setViewportSize({ width: 460, height: 900 });
    await check('统一输入容器，空态与登录态不遮挡输入', async () => {
      await load('&scene=empty');
      const visible = await page.locator('.overlay').isVisible();
      const hit = await page.locator('.composer-input').evaluate(el => {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(r.left + 10, r.top + 10) === el && el.closest('.composer-surface').contains(document.querySelector('.composer-bar'));
      });
      await page.evaluate(() => window.__fixture.post({ kind: 'account', data: { loggedIn: false } }));
      await page.waitForSelector('.gate-btn');
      return visible && hit && await page.locator('.send-btn').isDisabled();
    });
    await check('输入/Shift+Enter/中文组合输入/Enter 发送与禁用状态', async () => {
      await load();
      if (!await page.locator('.send-btn').isDisabled()) return false;
      const input = page.locator('.composer-input');
      await input.fill('验证排队');
      await input.press('Shift+Enter');
      await input.type('保留附件');
      await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
      if (await lastSent('send')) return false;
      await input.press('Enter');
      const sent = await lastSent('send');
      return sent?.content === '验证排队\n保留附件' && await input.inputValue() === '' && await page.locator('.send-btn').isDisabled();
    });
    await check('服务 ready 才允许发送，重连后保留草稿并恢复发送', async () => {
      await load();
      const input = page.locator('.composer-input');
      await input.fill('帮我推送代码到远端仓库');
      if (!await page.locator('.send-btn').isEnabled()) return false;
      for (const state of ['stopped', 'starting', 'failed', 'ready']) {
        await page.evaluate(state => window.__fixture.post({ kind: 'server-state', state }), state);
        await page.waitForFunction(state => document.querySelector('.send-btn').disabled === (state !== 'ready'), state);
        if (await input.inputValue() !== '帮我推送代码到远端仓库') return false;
      }
      await page.locator('.send-btn').click();
      return (await lastSent('send'))?.content === '帮我推送代码到远端仓库';
    });
    await check('运行态停止与后续消息发送使用原桥接载荷', async () => {
      await load();
      await page.evaluate(() => window.__fixture.status('running'));
      await page.waitForSelector('.send-btn.stop');
      await page.locator('.send-btn').click();
      if ((await lastSent('stop'))?.kind !== 'stop') return false;
      await page.locator('.composer-input').fill('继续检查');
      await page.locator('.send-btn').click();
      return (await lastSent('send'))?.content === '继续检查';
    });
    await check('附件菜单可添加/移除，发送包含原始路径', async () => {
      await load();
      await page.locator('[data-label="attach"]').click();
      await page.getByRole('menuitem', { name: '添加文件或图片' }).click();
      await page.waitForSelector('.attach-chip');
      await page.locator('.composer-input').fill('检查附件');
      await page.locator('.send-btn').click();
      const sent = await lastSent('send');
      if (sent?.attachments?.[0]?.path !== '/workspace/zcode-plugin/README.md') return false;
      await page.locator('[data-label="attach"]').click();
      await page.getByRole('menuitem', { name: '添加文件或图片' }).click();
      await page.locator('.attach-chip-x').click();
      return await page.locator('.attach-chip').count() === 0;
    });
    await check('斜杠/@ 引用键盘选择，菜单不会污染后续模型菜单', async () => {
      await load();
      const input = page.locator('.composer-input');
      await input.fill('/');
      await input.press('ArrowUp');
      await input.press('Enter');
      if (await input.inputValue() !== '/compact ') return false;
      await input.fill('/he');
      await input.press('ArrowDown');
      await input.press('Enter');
      if (await input.inputValue() !== '/help ') return false;
      await input.fill('@READ');
      await page.waitForSelector('.slash-item');
      await input.press('ArrowDown');
      await input.press('Enter');
      if (await input.inputValue() !== '@README.md ') return false;
      await page.locator('.model-chip').click();
      const clean = !await page.locator('.popup').evaluate(el => el.classList.contains('slash'));
      await page.keyboard.press('Escape');
      return clean;
    });
    await check('模型/推理菜单键盘选择，Escape 恢复焦点', async () => {
      await load();
      await page.locator('.model-chip').click();
      if (await page.locator('.reasoning-option').count() !== 3) return false;
      await page.keyboard.press('Escape');
      if (!await page.locator('.model-chip').evaluate(el => el === document.activeElement)) return false;
      await page.locator('.model-chip').click();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      return (await lastSent('set-model'))?.modelId === 'glm-5.3-flash';
    });
    await check('思考强度为横排低中高，无闪电标识，左右键选择发送原始档位', async () => {
      await load();
      if (await page.locator('.model-chip .icon-bolt').count()) return false;
      if (!await page.locator('.model-label').innerText().then(text => text.endsWith(' 高'))) return false;
      await page.locator('.model-chip').click();
      const options = page.locator('.reasoning-option');
      if ((await options.allTextContents()).join('/') !== '低/中/高') return false;
      const boxes = await options.evaluateAll(items => items.map(el => {
        const r = el.getBoundingClientRect();
        return { top: r.top, left: r.left, right: r.right };
      }));
      if (!boxes.every(box => box.top === boxes[0].top) || boxes[0].right > boxes[1].left || boxes[1].right > boxes[2].left) return false;
      await options.last().focus();
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      if ((await lastSent('set-model'))?.reasoningLevel !== 'high') return false;
      if (!await page.locator('.model-label').innerText().then(text => text.endsWith(' 中'))) return false;
      await page.locator('.model-chip').click();
      await options.first().focus();
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Enter');
      return (await lastSent('set-model'))?.reasoningLevel === 'max';
    });
    await check('多于三档的模型收敛为三档，缺档模型不发送无效值', async () => {
      await load();
      const setLevels = async (values, current) => {
        await page.evaluate(({ values, current }) => {
          const f = window.__fixture, data = f.makeSnapshot();
          data.settings.model.available[0].reasoning = {
            defaultLevel: current, levels: values.map(value => ({ value, label: value }))
          };
          data.settings.model.current.options.reasoningLevel = current;
          f.post({ kind: 'session-snapshot', data });
        }, { values, current });
        await page.locator('.model-chip').click();
      };
      await setLevels(['low', 'medium', 'high', 'xhigh', 'max'], 'xhigh');
      if ((await page.locator('.reasoning-option').allTextContents()).join('/') !== '低/中/高') return false;
      await page.locator('.reasoning-option').nth(1).click();
      if ((await lastSent('set-model'))?.reasoningLevel !== 'high') return false;
      await setLevels(['low', 'high'], 'high');
      if (!await page.locator('.reasoning-option').nth(1).isDisabled()) return false;
      await page.locator('.reasoning-option').first().click();
      if ((await lastSent('set-model'))?.reasoningLevel !== 'low') return false;
      await setLevels(['enabled'], 'enabled');
      return await page.locator('.reasoning-option:disabled').count() === 2
        && await page.locator('.reasoning-option').last().getAttribute('aria-checked') === 'true';
    });
    await check('四种权限模式保持独立，键盘切换只发送选中模式', async () => {
      await load();
      await page.locator('.mode-btn').click();
      if (await page.locator('.mode-item').count() !== 4) return false;
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      return (await lastSent('set-mode'))?.mode === 'edit';
    });
    await check('历史搜索过滤并恢复会话，不创建新会话', async () => {
      await load();
      await page.locator('[data-label="sessions"]').click();
      await page.locator('.menu-search').fill('附件');
      if (await page.locator('.session-menu-item').count() !== 1) return false;
      await page.locator('.menu-search').press('ArrowDown');
      await page.keyboard.press('Enter');
      return (await lastSent('resume'))?.sessionId === 's2' && !await lastSent('new-session');
    });
    await check('命令摘要去除 Bash 重复标题，展示状态与真实命令', async () => {
      await load();
      await page.evaluate(() => {
        const data = window.__fixture.makeSnapshot();
        data.messages[1].parts[1].state.title = 'Bash';
        window.__fixture.post({ kind: 'messages', data: { messages: data.messages } });
      });
      await page.waitForFunction(() => document.querySelector('.tool-card-name').textContent === '已运行');
      const card = page.locator('.tool-card').first();
      return (await card.locator('.tool-card-summary').innerText()).startsWith('rg -n')
        && await card.locator('.icon-terminal').count() === 1;
    });
    await check('权限入口四种模式均用 16px 盾牌叹号，完全访问保留警示色', async () => {
      await load();
      const colors = [];
      for (const mode of ['plan', 'build', 'edit', 'yolo']) {
        await page.evaluate(mode => {
          const data = window.__fixture.makeSnapshot();
          data.settings.mode.current = mode;
          window.__fixture.post({ kind: 'session-snapshot', data });
        }, mode);
        await page.waitForFunction(mode => document.querySelector('.mode-btn').classList.contains('full-access') === (mode === 'yolo'), mode);
        await page.waitForFunction(() => document.querySelector('.mode-btn').getAnimations().every(animation => animation.playState === 'finished'));
        const valid = await page.locator('.mode-btn').evaluate(el => {
          const icon = el.querySelector('.icon-shield');
          return icon && getComputedStyle(icon).width === '16px' && !el.querySelector('.icon-bolt');
        });
        if (!valid) return false;
        colors.push(await page.locator('.mode-btn').evaluate(el => getComputedStyle(el).color));
      }
      return colors[0] === colors[1] && colors[1] === colors[2] && colors[2] !== colors[3];
    });
    await check('命令等待/运行/完成/失败/拒绝/停止状态与输出一致，空详情不可展开', async () => {
      await load();
      for (const [status, label, icon] of [
        ['pending', '等待运行', 'spinner'], ['running', '正在运行', 'spinner'],
        ['completed', '已运行', 'terminal'], ['error', '运行失败', 'close'],
        ['denied', '已拒绝', 'close'], ['interrupted', '已停止', 'stop']
      ]) {
        await page.evaluate(status => {
          const data = window.__fixture.makeSnapshot();
          data.messages[1].parts[1].state = { status, title: 'Bash', input: { command: 'npm run typecheck' }, output: 'partial output', error: 'permission error' };
          window.__fixture.post({ kind: 'messages', data: { messages: data.messages } });
        }, status);
        const card = page.locator('.tool-card').first();
        await page.waitForFunction(label => document.querySelector('.tool-card-name').textContent === label, label);
        if (await card.locator('.icon-' + icon).count() !== 1
          || (await card.locator('.tool-command').textContent()) !== 'npm run typecheck'
          || !(await card.locator('.tool-card-body').textContent()).includes('partial output')) return false;
        if (['error', 'denied'].includes(status) && !await card.locator('.tool-card-body').isVisible()) return false;
      }
      await page.evaluate(() => {
        const data = window.__fixture.makeSnapshot();
        data.messages[1].parts[1].state = { status: 'pending' };
        window.__fixture.post({ kind: 'messages', data: { messages: data.messages } });
      });
      await page.waitForFunction(() => document.querySelector('.tool-card-header').disabled);
      return !await page.locator('.tool-card').first().locator('.tool-chevron').count();
    });
    await check('工具默认折叠，可键盘展开，刷新后保留展开选择', async () => {
      await load();
      const card = page.locator('.tool-card').first();
      if (await card.locator('.tool-card-body').isVisible()) return false;
      await card.locator('.tool-card-header').focus();
      await page.keyboard.press('Enter');
      if (!await card.locator('.tool-card-body').isVisible()) return false;
      await page.evaluate(() => {
        const data = window.__fixture.makeSnapshot();
        data.messages[1].parts[1].state.output += '\n刷新后的输出';
        window.__fixture.post({ kind: 'messages', data: { messages: data.messages } });
      });
      await page.waitForFunction(() => document.querySelector('.tool-card-body').textContent.includes('刷新后的输出'));
      return await card.locator('.tool-card-body').isVisible();
    });
    await check('消息与代码复制反馈，代码块保留语言和原文', async () => {
      await load();
      await page.locator('.code-header .copy-btn').click();
      const copied = await page.evaluate(() => window.__copied);
      if (!copied?.includes('await this.sendNow') || await page.locator('.code-header > span').innerText() !== 'typescript') return false;
      await page.locator('.msg-user .copy-btn').click();
      return (await page.evaluate(() => window.__copied))?.includes('检查会话的排队逻辑');
    });
    await check('权限卡应答原始 allow 载荷，重复通知不重复渲染', async () => {
      await load();
      await page.evaluate(() => { window.__fixture.permission(); window.__fixture.permission(); });
      await page.waitForSelector('.permission-card');
      if (await page.locator('.permission-card').count() !== 1) return false;
      await page.locator('.permission-card').press('1');
      return (await lastSent('permission-response'))?.response?.decision === 'allow';
    });
    await check('预览 Esc 关闭并恢复触发焦点；配对入口可达', async () => {
      await load();
      await page.evaluate(() => {
        const fixture = window.__fixture;
        const messages = fixture.makeSnapshot().messages;
        messages.push(fixture.message('image-message', 'user', [{ type: 'file', filename: 'image.png', mime: 'image/png',
          url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }]));
        fixture.post({ kind: 'messages', data: { messages } });
      });
      await page.locator('.msg-attachment').click();
      await page.waitForSelector('.preview-backdrop');
      await page.keyboard.press('Escape');
      if (await page.locator('.preview-backdrop').count() || !await page.locator('.msg-attachment').evaluate(el => el === document.activeElement)) return false;
      await page.locator('[data-label="settings"]').click();
      await page.getByRole('menuitem', { name: '手机配对', exact: true }).click();
      await page.waitForSelector('.pair-card');
      await page.keyboard.press('Escape');
      return (await lastSent('pair-phone'))?.kind === 'pair-phone' && await page.locator('.pair-card').count() === 0;
    });
    await check('上下文来源色条在真实 CSP 下保留宽度与颜色', async () => {
      await load('&csp=fixed');
      await page.evaluate(() => window.__fixture.context());
      await page.locator('.ctx-ring-btn').click();
      return page.locator('.ctx-seg').first().evaluate(el => getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)' && el.getBoundingClientRect().width > 0);
    });
    await check('问答选择使用原始 action/content，应答后卡片退出队列', async () => {
      await load();
      await page.evaluate(() => window.__fixture.question());
      await page.waitForSelector('.user-input-card');
      await page.locator('.user-input-card .ui-choice').first().click();
      await page.waitForFunction(() => window.__sent.some(m => m.kind === 'user-input-response'));
      const sent = await lastSent('user-input-response');
      return sent?.response?.action === 'accept' && await page.locator('.user-input-card').count() === 0;
    });
    await check('队列插队/移除入口发送正确条目 ID', async () => {
      await load();
      await page.evaluate(() => window.__fixture.post({ kind: 'queued-update', data: {
        queued: 2, items: [{ id: 'q1', content: '检查附件链路' }, { id: 'q2', content: '补充边界测试' }]
      } }));
      await page.waitForSelector('.queued-item');
      await page.locator('.queued-item').first().getByTitle('立即发送').click();
      await page.locator('.queued-item').last().getByTitle('取消').click();
      return (await lastSent('prioritize-queue-item'))?.id === 'q1' && (await lastSent('remove-queue-item'))?.id === 'q2';
    });
    await check('向上阅读不会被刷新拉回底部，最新消息按钮可恢复跟随', async () => {
      await load();
      await page.evaluate(() => {
        const f = window.__fixture;
        const messages = Array.from({ length: 60 }, (_, i) => f.message('long-' + i, i % 2 ? 'assistant' : 'user', [f.text('第 ' + i + ' 条长会话消息，用于检查滚动与后续消息跟随行为。')]));
        f.post({ kind: 'messages', data: { messages } });
      });
      await page.waitForSelector('[data-message-id="long-59"]');
      await page.locator('.messages').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
      await page.evaluate(() => window.__fixture.status('idle'));
      await page.waitForSelector('.jump-latest:not(.hidden)');
      if (!await page.locator('.messages').evaluate(el => el.scrollTop < 1)) return false;
      await page.locator('.jump-latest').click();
      await page.waitForFunction(() => {
        const el = document.querySelector('.messages');
        return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
      });
      return true;
    });
    await check('任务卡可用键盘展开，全部完成后可关闭', async () => {
      await load();
      await page.evaluate(() => {
        const f = window.__fixture;
        f.post({ kind: 'messages', data: { messages: [f.message('todos', 'assistant', [{
          type: 'tool', tool: 'TodoWrite', callId: 'todo-check', state: { status: 'completed', input: {
            todos: [{ content: '完成 UI 验证', status: 'completed' }]
          }, output: '完成' }
        }])] } });
      });
      await page.waitForSelector('.todo-panel-toggle');
      await page.locator('.todo-panel-toggle').focus();
      await page.keyboard.press('Enter');
      if (!await page.locator('.todo-panel-list').isVisible()) return false;
      await page.locator('.todo-panel-close').click();
      return !await page.locator('.todo-panel').isVisible();
    });
    await check('模型内部消息不显示，也不进入复制对话', async () => {
      await load();
      await page.evaluate(() => {
        const f = window.__fixture, data = f.makeSnapshot();
        const hidden = f.message('hidden', 'user', [f.text('hidden-model-context')]);
        hidden.info.visibility = 'model-only';
        data.messages.push(hidden);
        f.post({ kind: 'messages', data: { messages: data.messages } });
      });
      await page.locator('[data-label="chatActions"]').click();
      await page.getByRole('menuitem', { name: '复制对话', exact: true }).click();
      return !await page.locator('[data-message-id="hidden"]').count() && !String(await page.evaluate(() => window.__copied)).includes('hidden-model-context');
    });
    await check('错误与服务失败会禁用发送，设置保留重试入口', async () => {
      await load();
      await page.evaluate(() => window.__fixture.post({ kind: 'server-state', state: 'failed', detail: 'UI 验收模拟错误' }));
      await page.waitForSelector('.error-toast');
      await page.locator('[data-label="settings"]').click();
      return await page.locator('.send-btn').isDisabled() && await page.getByRole('menuitem', { name: '重试', exact: true }).isVisible();
    });
    await check('英文界面更新导航与输入标签', async () => {
      await load('&locale=en-US&scene=empty');
      return await page.getByRole('button', { name: 'New chat', exact: true }).count() === 1
        && await page.locator('.local-mode').innerText() === 'Local mode' && await page.locator('.composer-input').getAttribute('placeholder') === 'Describe a task, @ to add files';
    });
    await check('预览深链保留工具条，三栏展示真实产物', async () => {
      await page.goto(base + '/scripts/ui-preview.html?theme=dark');
      await page.locator('#cmp').click();
      return await page.locator('.preview-cell iframe').count() === 3 && await page.locator('.preview-cell iframe').first().evaluate(el => el.getBoundingClientRect().height > 600) && await page.locator('#harness').isVisible() && await page.locator('body').evaluate(el => el.classList.contains('vscode-dark'));
    });
    ok('全部场景无浏览器运行时错误', errors.length === 0, [...new Set(errors)].join('; '));
  } finally {
    await browser?.close();
    server.close();
  }
}

await browserChecks();
console.log(`── theme-check：${passed} 通过，${failures} 失败 ──`);
process.exit(failures ? 1 : 0);
