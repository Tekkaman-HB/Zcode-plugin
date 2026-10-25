/**
 * [INPUT]: theme-check 提供的真实 bundle 页面、加载器和检查器，Playwright clock 控制工具/推理刷新时序
 * [OUTPUT]: loadingChecks，处理中文字扫光/无旋转和秒表/刷新续播、思考结束固定用时/历史恢复/同色弱化与主题无障碍检查
 * [POS]: scripts/ 的处理状态回归模块，由 theme-check.mjs 调用，不启动 CLI 或请求模型
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
export async function loadingChecks(page, load, check) {
  await check('思考结束显示真实用时，历史恢复保持一致，缺失或无效时间不伪造数字', async () => {
    await load('&scene=empty');
    const render = async time => {
      await page.evaluate(time => {
        const f = window.__fixture, data = f.makeSnapshot('empty');
        const m = f.message('elapsed', 'assistant', [{ type: 'reasoning', text: '完成检查。' }, f.text('最终答复。')]);
        m.info.time = time; data.messages = [m];
        f.post({ kind: 'session-snapshot', data });
      }, time);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForSelector('.reasoning > summary');
      return page.locator('.reasoning > summary').innerText();
    };
    const start = 1700000000000;
    if (await render({ created: start, completed: start + 372000 }) !== '用时 6m 12s') return false;
    await load('&scene=empty');
    if (await render({ created: start, completed: start + 372000 }) !== '用时 6m 12s') return false;
    for (const [seconds, label] of [[0, '0s'], [9, '9s'], [60, '1m 0s']]) {
      if (await render({ created: start, completed: start + seconds * 1000 }) !== '用时 ' + label) return false;
    }
    for (const time of [undefined, { created: start }, { created: start, completed: start - 1 }, { created: 'bad', completed: start }]) {
      if (await render(time) !== '思考过程') return false;
    }
    await load('&scene=empty');
    await page.evaluate(() => {
      const f = window.__fixture;
      f.status('running');
      f.post({ kind: 'session-event', data: { type: 'model.streaming', sessionId: 's1', payload: {
        kind: 'reasoning_delta', assistantMessageId: 'live-elapsed', partId: 'elapsed-part', delta: '持续思考。'
      } } });
    });
    await page.waitForSelector('.reasoning-live');
    await page.evaluate(start => {
      const f = window.__fixture;
      const m = f.message('live-elapsed', 'assistant', [{ type: 'reasoning', partId: 'elapsed-part', text: '完成思考。' }]);
      m.info.time = { created: start, completed: start + 4000 };
      f.post({ kind: 'session-event', data: { type: 'message.upserted', sessionId: 's1', payload: { message: m } } });
    }, start);
    await page.waitForFunction(() => document.querySelector('.reasoning > summary')?.textContent === '用时 4s');
    if (await page.locator('.reasoning-live, .reasoning .processing').count()) return false;
    await load('&scene=empty&locale=en-US');
    if (await render({ created: start, completed: start + 372000 }) !== 'Worked for 6m 12s') return false;
    return !await page.locator('.think-secs, .think-pixel').count();
  });

  await check('展开思考与用时同色，Markdown 代码/强调/引用弱化，四主题窄栏与键盘可用', async () => {
    for (const theme of ['dark', 'light', 'hc', 'hclight']) {
      await load('&scene=empty&theme=' + theme);
      await page.evaluate(() => {
        const f = window.__fixture, data = f.makeSnapshot('empty');
        const m = f.message('reasoning-colors', 'assistant', [
          { type: 'reasoning', text: '先核对**边界条件**与 `sessionChanges`。\n\n> 检查保存路径。\n\n```ts\nconst verified = true;\n```' },
          f.text('这是最终答复，应比思考过程更突出。')
        ]);
        m.info.time = { created: 1700000000000, completed: 1700000372000 }; data.messages = [m];
        f.post({ kind: 'session-snapshot', data });
      });
      await page.waitForSelector('.reasoning > summary');
      await page.locator('.reasoning > summary').focus();
      await page.keyboard.press('Enter');
      if (!await page.locator('.reasoning-body').isVisible()) return false;
      for (const width of [260, 460]) {
        await page.setViewportSize({ width, height: 900 });
        const valid = await page.locator('.reasoning').evaluate(el => {
          const summary = el.querySelector('summary'), body = el.querySelector('.reasoning-body');
          const color = getComputedStyle(summary).color;
          return getComputedStyle(body).color === color
            && [...body.querySelectorAll('p, strong, code, blockquote')].every(n => getComputedStyle(n).color === color)
            && getComputedStyle(el.parentElement.querySelector(':scope > .md')).color !== color
            && document.documentElement.scrollWidth <= innerWidth;
        });
        if (!valid) return false;
      }
      await page.keyboard.press('Enter');
      if (await page.locator('.reasoning-body').isVisible()) return false;
    }
    return true;
  });

  await check('首响等待只有扫光文字，没有旋转图形、秒表或 JS 秒表定时器', async () => {
    await load('&scene=empty');
    await page.evaluate(() => {
      window.__loadingIntervals = 0;
      const interval = window.setInterval;
      window.setInterval = (...args) => { window.__loadingIntervals++; return interval(...args); };
      const f = window.__fixture;
      f.post({ kind: 'optimistic-user', data: { id: 'loading-user', text: '检查处理状态' } });
      f.status('running');
    });
    await page.waitForSelector('.msg-thinking');
    return page.evaluate(() => {
      const label = document.querySelector('.msg-thinking .processing');
      return label?.textContent === '正在处理' && getComputedStyle(label).animationName === 'shimmer-text'
        && !document.querySelector('.think-pixel, .think-secs, .icon-spinner, .perm-spinner') && window.__loadingIntervals === 0;
    });
  });

  await check('推理中夹杂工具刷新时扫光续播，不创建秒表或旋转动画', async () => {
    await load('&scene=empty');
    const p = await page.context().browser().newPage({ viewport: { width: 460, height: 900 } });
    try {
      await p.clock.install();
      await p.goto(page.url());
      await p.waitForSelector('.model-label');
      await p.evaluate(() => {
        const f = window.__fixture;
        window.__loadingIntervals = 0;
        const interval = window.setInterval;
        window.setInterval = (...args) => { window.__loadingIntervals++; return interval(...args); };
        f.status('running');
        f.post({ kind: 'messages', data: { messages: [f.message('a-clock', 'assistant', [
          { type: 'tool', partId: 'live-tool', callId: 'c-clock', tool: 'Bash', state: { status: 'running', input: { command: 'work' } } }
        ])] } });
        f.post({ kind: 'session-event', data: { type: 'model.streaming', sessionId: 's1', payload: {
          kind: 'reasoning_delta', assistantMessageId: 'a-clock', partId: 'reasoning-clock', delta: '持续推理'
        } } });
      });
      await p.clock.runFor(32);
      await p.waitForSelector('.reasoning-live');
      await p.clock.runFor(2200);
      for (let i = 0; i < 10; i++) {
        await p.evaluate(i => window.__fixture.post({ kind: 'session-event', data: {
          type: 'part.upserted', sessionId: 's1', payload: { part: {
            type: 'tool', partId: 'live-tool', messageId: 'a-clock', callId: 'c-clock', tool: 'Bash',
            state: { status: 'running', input: { command: 'work' }, output: 'step' + i }
          } }
        } }), i);
        await p.clock.runFor(400);
      }
      return p.evaluate(() => {
        const label = document.querySelector('.reasoning-live .processing');
        const delay = parseFloat(label?.style.animationDelay ?? '0');
        return label?.textContent === '正在思考' && delay < -5000 && Math.abs(delay + performance.now()) < 500
          && !document.querySelector('.think-secs, .think-pixel, .icon-spinner') && window.__loadingIntervals === 0
          && !document.getAnimations().some(a => /^(spin|perm-spin)$/.test(a.animationName));
      });
    } finally { await p.close(); }
  });

  await check('四主题扫光文字可读，减少动态效果与强制颜色模式使用静态文字', async () => {
    for (const theme of ['dark', 'light', 'hc', 'hclight']) {
      await load('&scene=empty&theme=' + theme);
      await page.evaluate(() => {
        const f = window.__fixture;
        f.post({ kind: 'optimistic-user', data: { id: 'motion-user', text: '检查无障碍' } }); f.status('running');
      });
      await page.waitForSelector('.processing');
      const normal = await page.locator('.msg-thinking .processing').evaluate(el => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.backgroundClip === 'text' && s.backgroundImage.includes('linear-gradient') && r.width > 20 && r.right < innerWidth;
      });
      if (!normal) throw new Error('Normal shimmer failed: ' + theme);
      for (const media of [{ reducedMotion: 'reduce' }, { reducedMotion: 'no-preference', forcedColors: 'active' }]) {
        await page.emulateMedia(media);
        const staticState = await page.locator('.msg-thinking .processing').evaluate(el => {
          const s = getComputedStyle(el);
          return { animation: s.animationName, background: s.backgroundImage, color: s.color };
        });
        if (staticState.animation !== 'none' || staticState.background !== 'none' || staticState.color === 'rgba(0, 0, 0, 0)') {
          await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
          throw new Error(theme + ' ' + JSON.stringify({ media, staticState }));
        }
      }
      await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
    }
    return true;
  });

  await check('处理状态进入最终正文后退出扫光，已完成工具保留静态语义图标', async () => {
    await load();
    await page.evaluate(() => {
      const f = window.__fixture;
      f.status('idle'); f.post({ kind: 'messages', data: { messages: f.makeSnapshot().messages } });
    });
    await page.waitForSelector('.tool-card-completed', { state: 'attached' });
    return await page.locator('.messages .processing, .think-secs, .think-pixel, .icon-spinner').count() === 0
      && await page.locator('.tool-card-completed .icon-terminal').count() === 1;
  });
}
