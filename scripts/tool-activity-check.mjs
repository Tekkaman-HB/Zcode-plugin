/**
 * [INPUT]: theme-check 的真实 bundle 页面、加载器和检查器，ui-fixtures 的协议消息桩
 * [OUTPUT]: toolActivityChecks，跨消息工具行密度、空部件过滤、流式正文接管与 Codex 工具图标回归
 * [POS]: scripts/ 的工具活动验收模块，由 theme-check 调用，不启动 CLI 或请求模型
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
async function postTools(page, tools) {
  await page.evaluate(tools => {
    const f = window.__fixture;
    const messages = tools.map((tool, i) => f.message(`tool-${i}`, 'assistant', [
      { type: 'step-start' }, f.text(i % 2 ? '' : '\n  '),
      { type: 'tool', tool, callId: `call-${i}`, state: { status: 'completed',
        input: tool === 'Bash' ? { command: 'npm run typecheck' } : { file_path: 'src/ui/sessionChanges.ts' }, output: 'done' } },
      { type: 'step-finish' }
    ]));
    messages.splice(1, 0, f.message('boundary-only', 'assistant', [{ type: 'step-start' }, { type: 'step-finish' }]));
    f.post({ kind: 'messages', data: { messages } });
  }, tools);
  await page.waitForSelector('[data-message-id="tool-0"] .tool-card-header');
}

export async function toolActivityChecks(page, load, check) {
  await check('跨消息工具行紧凑连续，回合边界和空文本不占位，正文接管恢复正常段距', async () => {
    for (const theme of ['dark', 'light', 'hc', 'hclight']) {
      await load('&scene=empty&theme=' + theme);
      await postTools(page, ['Read', 'Edit', 'Bash']);
      for (const width of [260, 460]) {
        await page.setViewportSize({ width, height: 900 });
        const compact = await page.locator('.messages').evaluate(el => {
          const rows = [...el.querySelectorAll('.tool-card-header')].map(row => row.getBoundingClientRect());
          return rows.length === 3 && rows.every((row, i) => row.height >= 24 && row.height <= 28
            && (!i || row.y - rows[i - 1].y <= 28))
            && !el.querySelector('.step-marker, .message-actions, .md, [data-message-id="boundary-only"]')
            && document.documentElement.scrollWidth <= innerWidth;
        });
        if (!compact) return false;
      }
    }
    await page.evaluate(() => {
      const f = window.__fixture;
      f.status('running');
      f.post({ kind: 'session-event', data: { type: 'part.upserted', sessionId: 's1', payload: { part: {
        type: 'text', partId: 'tool-prose', messageId: 'tool-0', sessionId: 's1', text: '工具执行后的说明正文。'
      } } } });
    });
    await page.waitForSelector('[data-part-id="tool-prose"]');
    return page.locator('[data-message-id="tool-0"]').evaluate(el =>
      !el.classList.contains('msg-tool-only') && parseFloat(getComputedStyle(el).marginTop) >= 12);
  });

  await check('工具图标对齐 Codex：读取/命令用方框终端，编辑用铅笔，搜索用放大镜，技能/MCP 用扳手', async () => {
    await load('&scene=empty');
    const cases = [['Read', 'terminal'], ['Bash', 'terminal'], ['Edit', 'edit'], ['Write', 'edit'],
      ['Grep', 'search'], ['Glob', 'search'], ['Skill', 'tool'], ['mcp__serena__read_file', 'tool'], ['UnknownTool', 'tool']];
    await postTools(page, cases.map(([name]) => name));
    for (let i = 0; i < cases.length; i++) {
      const icon = page.locator(`[data-message-id="tool-${i}"] .tool-status-icon > .icon-${cases[i][1]}`);
      if (await icon.count() !== 1 || !await icon.evaluate(el => {
        const r = el.getBoundingClientRect(), svg = el.querySelector('svg');
        return r.width === 16 && r.height === 16 && svg.getAttribute('aria-hidden') === 'true';
      })) return false;
    }
    await page.evaluate(() => {
      const f = window.__fixture;
      f.post({ kind: 'messages', data: { messages: [f.message('group', 'assistant', ['Read', 'Skill'].map((tool, i) => ({
        type: 'tool', tool, callId: `group-${i}`, state: { status: 'completed', input: { file_path: 'src/CLAUDE.md' }, output: 'done' }
      })))] } });
    });
    await page.waitForSelector('.tool-activity > summary > .icon-tool');
    return true;
  });
}
