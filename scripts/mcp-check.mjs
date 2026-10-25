/**
 * [INPUT]: esbuild/node 临时目录、SessionController、theme-check 的真实产物浏览器与 UI fixture 消息桥
 * [OUTPUT]: mcpChecks，验证配置/进程合并与去重、忽略 workspace 状态，以及未连接服务可见、红灯/文案、异常置顶、全失败与恢复刷新
 * [POS]: scripts/ 的 MCP 菜单回归，由 theme-check 调用，无 CLI 或网络请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function mcpChecks(page, load, check) {
  await check('MCP 清单补齐失败服务、按原始名称合并插件/重复进程且忽略 workspace 状态', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'zcode-mcp-check-'));
    try {
      const output = path.join(temp, 'controller.mjs');
      await build({ stdin: { contents: `export { SessionController } from './src/sessionController';`, resolveDir: process.cwd() },
        bundle: true, platform: 'node', format: 'esm', outfile: output, plugins: [{ name: 'vscode-double', setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test' }));
          build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `export const env = { language: 'zh-CN' };` }));
        } }] });
      const { SessionController } = await import(output);
      const calls = [];
      let processes = [
        { pid: 1, serverName: 'plugin:documents:documents', pluginName: 'documents', mcpSource: 'builtin' },
        { pid: 2, serverName: 'plugin:documents:documents', pluginName: 'documents', mcpSource: 'builtin' }
      ];
      const controller = new SessionController({ workspacePath: '/workspace', request: async (method, params) => {
        calls.push(method);
        if (method === 'process/childProcesses') return { processes };
        if (method !== 'mcp/list' || params.mode !== 'status' || params.workspace.workspacePath !== '/workspace') throw new Error('unexpected request');
        return { statuses: {
          'plugin:documents:documents': { transport: 'stdio', status: 'disconnected' },
          iconstack: { transport: 'stdio', status: 'connected' },
          remote: { transport: 'http', status: 'disconnected' }
        } };
      } }, { toWebview() {} });
      const rows = await controller.fetchMcpServers();
      if (rows.length !== 3 || rows[0].name !== 'documents' || rows[0].connected !== true || !rows[0].pid
        || rows[1].name !== 'iconstack' || rows[1].connected !== false || rows[1].pid !== undefined
        || rows[2].connected !== null || calls.join(',') !== 'mcp/list,process/childProcesses') return false;
      processes = [];
      const offline = await controller.fetchMcpServers();
      return offline.length === 3 && offline.filter(row => row.connected === false).length === 2;
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
  const open = async () => {
    await page.locator('[data-label="settings"]').click();
    await page.getByRole('menuitem', { name: /MCP/ }).click();
    await page.waitForSelector('.mcp-menu .mcp-server-name');
  };
  await check('MCP 未连接项显示红灯/文案并置顶，在线项保留绿灯', async () => {
    for (const theme of ['dark', 'light', 'hc', 'hclight']) {
      await load('&theme=' + theme);
      await open();
      await page.evaluate(() => {
        window.__fixture.post({ kind: 'mcp-progress', data: { started: 2, done: true, configuredCount: 2, connectedCount: 1, failedCount: 1 } });
        window.__fixture.post({ kind: 'mcp-servers', data: { running: true, servers: [
          { name: 'documents', pid: 1234, source: 'plugin', connected: true },
          { name: 'failed-mcp', source: 'custom', connected: false }
        ] } });
      });
      await page.waitForFunction(() => document.querySelectorAll('.mcp-server-name').length === 2);
      const rows = page.locator('.mcp-menu .menu-item');
      if (await rows.first().locator('.mcp-server-name').innerText() !== 'failed-mcp'
        || await rows.first().locator('.mcp-dot.bad').count() !== 1
        || await rows.first().locator('.menu-item-meta').innerText() !== '未连接'
        || (await rows.first().getAttribute('title')).includes('undefined')
        || await rows.last().locator('.mcp-dot.ok').count() !== 1) return false;
      const colors = await page.locator('.mcp-dot').evaluateAll(dots => dots.map(dot => getComputedStyle(dot).backgroundColor));
      if (colors[0] === colors[1]) return false;
    }
    return true;
  });
  await check('MCP 全部未连接仍保留列表，恢复后移除红灯，英文状态正确', async () => {
    await load('&locale=en-US');
    await open();
    await page.evaluate(() => window.__fixture.post({ kind: 'mcp-servers', data: { running: true,
      servers: [{ name: 'failed-mcp', source: 'custom', connected: false }] } }));
    await page.waitForFunction(() => document.querySelector('.mcp-server-name')?.textContent === 'failed-mcp');
    if (await page.locator('.mcp-dot.bad').count() !== 1 || await page.locator('.mcp-menu .menu-item-meta').innerText() !== 'Disconnected') return false;
    await page.evaluate(() => window.__fixture.post({ kind: 'mcp-servers', data: { running: true,
      servers: [{ name: 'failed-mcp', pid: 4321, source: 'custom', connected: true }] } }));
    await page.waitForSelector('.mcp-dot.ok');
    return await page.locator('.mcp-dot.bad').count() === 0 && (await page.locator('.mcp-menu .menu-item').getAttribute('title')).includes('4321');
  });
}
