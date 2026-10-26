/**
 * [INPUT]: esbuild、临时文件系统、真实 ChatViewProvider 与 theme-check 浏览器/fixture 消息桥
 * [OUTPUT]: composerChecks，验证中英文粘贴图片经宿主落盘后恢复发送，保留缩略图与真实文件路径
 * [POS]: scripts/ 的附件链路回归；连接真实宿主处理器和 webview，隔离临时目录，无 CLI/模型请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    const output = path.join(temp, 'provider.mjs');
    await build({ entryPoints: ['src/ui/chatProvider.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output,
      plugins: [{ name: 'host-double', setup(build) {
        build.onResolve({ filter: /^(vscode|node:os)$/ }, args => ({ path: args.path, namespace: 'test' }));
        build.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'vscode'
          ? `export const env = { language: 'zh-CN' }, Uri = {}, workspace = {}, window = {}, commands = {}, FileSystemError = {}, FileType = {}, FilePermission = {}, EventEmitter = class {}, Disposable = class {};`
          : `export const tmpdir = () => ${JSON.stringify(temp)};` }));
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
  } finally {
    await page.close();
    await rm(temp, { recursive: true, force: true });
  }
}
