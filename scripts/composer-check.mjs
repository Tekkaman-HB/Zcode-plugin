/**
 * [INPUT]: esbuild、临时文件系统、真实 ChatViewProvider 与 theme-check 浏览器/fixture 消息桥
 * [OUTPUT]: composerChecks，验证摘要关闭/焦点恢复/会话隔离/刷新保持与四主题窄栏；验证中英文粘贴图片经宿主落盘后恢复发送，保留缩略图与真实文件路径；验证停止/完成回合后的 artifact 持久图片、历史恢复/实时回流/同名附件与文件选择的真实图片预览
 * [POS]: scripts/ 的输入区摘要与附件链路回归；连接真实宿主处理器和 webview，隔离临时目录，无 CLI/模型请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9kAAAAASUVORK5CYII=';

export async function composerChecks(sourcePage, check) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'zcode-composer-check-'));
  const page = await sourcePage.context().browser().newPage({ viewport: { width: 460, height: 900 } });
  page.setDefaultTimeout(4000);
  const load = async query => {
    const url = new URL(sourcePage.url());
    url.search = '?harness=0' + query;
    await page.goto(url.href);
    await page.waitForSelector('.model-label');
  };
  try {
    await check('变更摘要可点击/键盘关闭并恢复输入焦点，刷新和切回保持关闭，其他会话独立', async () => {
      for (const locale of ['zh-CN', 'en-US']) {
        await load('&locale=' + locale);
        const publish = sessionId => page.evaluate(sessionId => window.__fixture.post({ kind: 'session-changes',
          data: { sessionId, status: 'ready', files: 2, added: 15, deleted: 3, binary: 0 } }), sessionId);
        await publish('s1');
        const dismiss = page.getByRole('button', { name: locale === 'zh-CN' ? '关闭变更摘要' : 'Dismiss change summary' });
        await dismiss.waitFor();
        if (locale === 'zh-CN') await dismiss.click();
        else { await dismiss.focus(); await page.keyboard.press('Enter'); }
        if (await page.locator('.changes-summary').isVisible()
          || await page.locator('.composer-context.has-changes').count()
          || !await page.locator('.composer-input').evaluate(el => el === document.activeElement)) return false;
        await publish('s1');
        await page.evaluate(() => window.__fixture.snapshot('empty', 's1'));
        await publish('s1');
        if (await page.locator('.changes-summary').isVisible()) return false;
        await page.evaluate(() => window.__fixture.snapshot('empty', 's2'));
        await publish('s2');
        await page.waitForSelector('.changes-summary:visible');
        await page.evaluate(() => window.__fixture.snapshot('empty', 's1'));
        await publish('s1');
        if (await page.locator('.changes-summary').isVisible()) return false;
      }
      return true;
    });
    await check('准备中的变更摘要也可关闭，后续完成消息保持收起', async () => {
      await load();
      await page.evaluate(() => window.__fixture.post({ kind: 'session-changes',
        data: { sessionId: 's1', status: 'preparing', files: 0, added: 0, deleted: 0, binary: 0 } }));
      await page.locator('.changes-dismiss').click();
      await page.evaluate(() => window.__fixture.post({ kind: 'session-changes',
        data: { sessionId: 's1', status: 'ready', files: 1, added: 4, deleted: 1, binary: 0 } }));
      return !await page.locator('.changes-summary').isVisible()
        && !await page.locator('.composer-context.has-changes').count();
    });
    await check('摘要关闭按钮在四主题/280px 窄栏内可见、可聚焦且无遮挡', async () => {
      await page.setViewportSize({ width: 280, height: 900 });
      for (const theme of ['dark', 'light', 'hc', 'hclight']) {
        await load('&theme=' + theme);
        await page.evaluate(() => window.__fixture.post({ kind: 'session-changes',
          data: { sessionId: 's1', status: 'partial', files: 123, added: 123456, deleted: 98765, binary: 1 } }));
        await page.locator('.changes-dismiss').focus();
        const valid = await page.locator('.changes-dismiss').evaluate(el => {
          const r = el.getBoundingClientRect(), style = getComputedStyle(el);
          return document.documentElement.scrollWidth <= innerWidth && r.right <= innerWidth
            && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            && el === document.activeElement && style.outlineStyle !== 'none';
        });
        if (!valid) return false;
      }
      await page.setViewportSize({ width: 460, height: 900 });
      return true;
    });
    const output = path.join(temp, 'provider.mjs');
    await build({ entryPoints: ['src/ui/chatProvider.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output,
      plugins: [{ name: 'host-double', setup(build) {
        build.onResolve({ filter: /^(vscode|node:os)$/ }, args => ({ path: args.path, namespace: 'test' }));
        build.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'vscode'
          ? `export const env = { language: 'zh-CN' }, Uri = {}, workspace = { fs: { stat: async uri => (await import('node:fs/promises')).stat(uri.fsPath) } }, window = { showOpenDialog: async () => globalThis.__picked }, commands = {}, FileSystemError = {}, FileType = {}, FilePermission = {}, EventEmitter = class {}, Disposable = class {};`
          : `export const tmpdir = () => ${JSON.stringify(temp)}, homedir = () => ${JSON.stringify(temp)};` }));
      } }] });
    const { ChatViewProvider } = await import(output);
    const provider = new ChatViewProvider({ locale: 'zh-CN', controller: () => null, server: () => null });
    const replies = [];
    provider.post = msg => { replies.push(msg); };
    await page.exposeFunction('__saveImage', async msg => { await provider.onMessage(msg); });
    for (const locale of ['zh-CN', 'en-US']) {
      await check(`${locale} 粘贴图片落盘后可点击发送，缩略图/文件内容/路径完整`, async () => {
        await load('&locale=' + locale);
        const content = locale === 'zh-CN' ? '带图片的输入' : '';
        await page.locator('.composer-input').fill(content);
        for (let i = 0; i < 2; i++) {
          const previous = replies.length;
          await page.evaluate(image => {
            const clipboardData = new DataTransfer();
            clipboardData.items.add(new File([Uint8Array.from(atob(image), c => c.charCodeAt(0))], 'clipboard.png', { type: 'image/png' }));
            document.querySelector('.composer-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
          }, image);
          await page.waitForFunction(count => window.__sent.filter(m => m.kind === 'save-image').length === count, i + 1);
          assert.equal(await page.locator('.send-btn').isDisabled(), true, '落盘中应禁用发送');
          for (let n = 0; replies.length === previous && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 10));
          assert.equal(replies.length, previous + 1, '宿主应答完成');
          const request = await page.evaluate(() => window.__sent.filter(m => m.kind === 'save-image').at(-1));
          assert.equal(replies.at(-1).data.name, request.name, '落盘回包必须保留请求名称以结束等待');
          await page.evaluate(msg => window.__fixture.post(msg), replies.at(-1));
          await page.waitForFunction(count => document.querySelectorAll('.attach-chip').length === count, i + 1);
          assert.equal(await page.locator('.send-btn').isEnabled(), true, '图片已落盘，发送按钮仍被禁用');
        }
        assert.equal(await page.locator('.attach-thumb').count(), 2, '粘贴缩略图应保留');
        await page.waitForFunction(() => [...document.querySelectorAll('.attach-thumb')].every(img => img.naturalWidth > 0));
        await page.locator('.send-btn').click();
        const sent = await page.evaluate(() => window.__sent.filter(m => m.kind === 'send').at(-1));
        assert.equal(sent.content, content);
        assert.equal(sent.attachments.length, 2);
        for (const [i, attachment] of sent.attachments.entries()) {
          assert.equal(attachment.name, `${locale === 'zh-CN' ? '图片' : 'Image'}${i + 1}.png`);
          assert.equal(attachment.mime, 'image/png');
          assert.deepEqual(await readFile(attachment.path), Buffer.from(image, 'base64'));
        }
        return true;
      });
    }
    await check('历史本地图片恢复缩略图，点击可预览且同名附件不串图', async () => {
      await load('&scene=empty');
      const files = replies.filter(msg => msg.kind === 'image-saved').slice(-2).map(msg => msg.data.path);
      await writeFile(files[1], Buffer.concat([Buffer.from(image, 'base64'), Buffer.from('different-image')]));
      const urls = files.map(file => pathToFileURL(file).href);
      const snapshot = await page.evaluate(urls => {
        const f = window.__fixture, data = f.makeSnapshot('empty');
        data.messages = urls.map((url, i) => f.message('history-' + i, 'user', [
          { type: 'file', filename: '1.png', mime: 'image/png', url }
        ]));
        return data;
      }, urls);
      // 保留真实 post 路径，把宿主回包接入页面，而非伪造预览数据。
      delete provider.post;
      provider.host.sessionChanges = { select() {} };
      provider.host.workspacePath = () => temp;
      provider.view = { webview: { postMessage: msg => page.evaluate(msg => window.__fixture.post(msg), msg) } };
      provider.post({ kind: 'session-snapshot', data: snapshot });
      await page.waitForSelector('.msg-attach-thumb');
      await page.waitForFunction(() => [...document.querySelectorAll('.msg-attach-thumb')].every(img => img.naturalWidth > 0), null, { timeout: 3000 });
      for (let i = 0; i < files.length; i++) {
        const expected = 'data:image/png;base64,' + (await readFile(files[i])).toString('base64');
        assert.equal(await page.locator('.msg-attach-thumb').nth(i).getAttribute('src'), expected);
        await page.locator('.msg-attachment-img').nth(i).click();
        await page.waitForSelector('.preview-img');
        assert.equal(await page.locator('.preview-img').getAttribute('src'), expected);
        await page.waitForFunction(() => document.querySelector('.preview-img')?.naturalWidth > 0);
        await page.keyboard.press('Escape');
      }
      // 同一数据经权威刷新与实时事件回流也必须保留缩略图和预览。
      provider.post({ kind: 'messages', data: { messages: snapshot.messages } });
      await page.waitForFunction(() => [...document.querySelectorAll('.msg-attach-thumb')].every(img => img.naturalWidth > 0));
      await load('&scene=empty');
      provider.post({ kind: 'session-snapshot', data: { ...snapshot, messages: [] } });
      provider.post({ kind: 'session-event', data: { type: 'message.upserted', sessionId: 's1', payload: { message: snapshot.messages[0] } } });
      await page.waitForSelector('.msg-attach-thumb');
      await page.waitForFunction(() => document.querySelector('.msg-attach-thumb')?.naturalWidth > 0);
      return true;
    });
    for (const completion of ['turn.failed', 'turn.completed']) await check(`${completion} 后 artifact 图片可预览，原临时图删除仍可恢复历史`, async () => {
      await load('&scene=empty');
      provider.post({ kind: 'session-snapshot', data: await page.evaluate(() => window.__fixture.makeSnapshot('empty')) });
      const file = path.join(temp, '1.png');
      const dataUrl = 'data:image/png;base64,' + image;
      await writeFile(file, Buffer.from(image, 'base64'));
      globalThis.__picked = [{ path: file, fsPath: file }];
      await provider.onMessage({ kind: 'attach-pick' });
      await page.waitForSelector('.attach-thumb');
      await page.locator('.composer-input').fill('测试一下截图，不要修改代码');
      await page.locator('.send-btn').click();
      provider.post({ kind: 'optimistic-user', data: { id: 'local-stopped', text: '测试一下截图，不要修改代码', attachments: [{ name: '1.png' }] } });
      await page.locator('.msg-attachment-img').click();
      await page.waitForSelector('.preview-img');
      await page.keyboard.press('Escape');
      const artifactId = 'tool-result-00000000-0000-4000-8000-000000000000';
      const sessionId = 'sess_11111111-1111-4111-8111-111111111111';
      const dir = path.join(temp, '.zcode/cli/artifacts', sessionId);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'attachment-1-' + artifactId + '.txt'), dataUrl);
      await rm(file);
      const snapshot = await page.evaluate(({ sessionId, artifactId, file }) => {
        const f = window.__fixture, data = f.makeSnapshot('empty');
        data.messages = [f.message('stored-user', 'user', [f.text('测试一下截图，不要修改代码'), {
          type: 'file', filename: '1.png', mime: 'image/png',
          url: 'zcode-artifact://' + sessionId + '/' + artifactId,
          source: { type: 'file', path: file },
          metadata: { originalUrl: file, storageKind: 'artifact', recoverability: 'provider_ready' }
        }])];
        return data;
      }, { sessionId, artifactId, file });
      provider.post({ kind: 'session-event', data: { type: 'session.updated', sessionId: 's1', payload: { status: 'running' } } });
      await page.waitForSelector('.send-btn.stop');
      if (completion === 'turn.failed') {
        await page.locator('.send-btn').click();
        assert.equal(await page.evaluate(() => window.__sent.at(-1).kind), 'stop');
      }
      provider.post({ kind: 'session-event', data: { type: completion, sessionId: 's1', payload: {} } });
      provider.post({ kind: 'messages', data: { messages: snapshot.messages } });
      await page.waitForSelector('[data-message-id="stored-user"]');
      await page.waitForFunction(() => document.querySelector('.msg-attach-thumb')?.naturalWidth > 0, null, { timeout: 3000 });
      await page.locator('.msg-attachment-img').click();
      await page.waitForSelector('.preview-img', { timeout: 3000 });
      assert.equal(await page.locator('.preview-img').getAttribute('src'), dataUrl);
      await page.waitForFunction(() => document.querySelector('.preview-img')?.naturalWidth > 0);
      await page.keyboard.press('Escape');
      await load('&scene=empty');
      provider.post({ kind: 'session-snapshot', data: snapshot });
      await page.waitForFunction(() => document.querySelector('.msg-attach-thumb')?.naturalWidth > 0, null, { timeout: 3000 });
      await page.locator('.msg-attachment-img').click();
      await page.waitForSelector('.preview-img');
      assert.equal(await page.locator('.preview-img').getAttribute('src'), dataUrl);
      return true;
    });
    await check('已删除的历史图片保留文件名，不显示破图或错误预览', async () => {
      await load('&scene=empty');
      const data = await page.evaluate(url => {
        const f = window.__fixture, data = f.makeSnapshot('empty');
        data.messages = [f.message('missing-file', 'user', [{ type: 'file', filename: 'missing.png', mime: 'image/png', url }])];
        return data;
      }, pathToFileURL(path.join(temp, 'missing.png')).href);
      provider.post({ kind: 'session-snapshot', data });
      await page.waitForSelector('.msg-attachment-img');
      assert.equal(await page.locator('.msg-attach-thumb').isVisible(), false);
      await page.locator('.msg-attachment-img').click();
      await page.waitForSelector('.error-toast');
      assert.equal(await page.locator('.preview-img').count(), 0);
      return true;
    });
    await check('选择本地图片立即带缩略图，发送后附件可点击预览', async () => {
      await load('&scene=empty');
      const file = replies.find(msg => msg.kind === 'image-saved').data.path;
      globalThis.__picked = [{ path: file, fsPath: file }];
      await provider.onMessage({ kind: 'attach-pick' });
      await page.waitForSelector('.attach-thumb');
      await page.waitForFunction(() => document.querySelector('.attach-thumb')?.naturalWidth > 0);
      await page.locator('.send-btn').click();
      const sent = await page.evaluate(() => window.__sent.filter(msg => msg.kind === 'send').at(-1));
      assert.equal(sent.attachments[0].path, file);
      provider.post({ kind: 'optimistic-user', data: { id: 'local-picked', text: '', attachments: [{ name: sent.attachments[0].name }] } });
      await page.locator('.msg-attachment-img').click();
      await page.waitForSelector('.preview-img');
      await page.waitForFunction(() => document.querySelector('.preview-img')?.naturalWidth > 0);
      return true;
    });
  } finally {
    delete globalThis.__picked;
    await page.close();
    await rm(temp, { recursive: true, force: true });
  }
}
