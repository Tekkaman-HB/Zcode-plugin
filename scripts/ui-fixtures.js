/**
 * [INPUT]: 真实 out/webview/main.js 的消息桥；仅使用本文件内的模拟会话数据
 * [OUTPUT]: UI 预览和 theme-check 共用的 __fixture / acquireVsCodeApi 桩；可委托 __saveImage 接入真实宿主，服务就绪用 ready，GLM 三档用 low/high/max，不启动 CLI 或请求网络
 * [POS]: scripts/ 的界面场景层；ui-live.html 挂载，ui-preview.html 承载主题对比
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
(() => {
  const params = new URLSearchParams(location.search);
  const themes = { light: '', dark: 'vscode-dark', hc: 'vscode-high-contrast', hclight: 'vscode-high-contrast-light' };
  document.body.className = themes[params.get('theme')] || '';
  document.body.dataset.logo = '/media/zcode-icon.png';
  const locale = params.get('locale') || 'zh-CN';
  const now = Date.now();
  const post = message => window.postMessage(message, '*');
  const message = (id, role, parts) => ({
    info: { messageId: id, role },
    parts: parts.map((part, i) => ({ partId: `${id}-${i}`, sessionId: 's1', messageId: id, ...part }))
  });
  const text = value => ({ type: 'text', text: value });
  const models = [
    { ref: { providerId: 'p', modelId: 'glm-5.3' }, label: 'GLM-5.3', providerLabel: 'Z.AI', contextWindow: 1000000,
      reasoning: { defaultLevel: 'max', levels: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }, { value: 'max', label: 'max' }] } },
    { ref: { providerId: 'p', modelId: 'glm-5.3-flash' }, label: 'GLM-5.3-Flash', providerLabel: 'Z.AI', contextWindow: 200000 }
  ];
  const messages = [
    message('u1', 'user', [text('检查会话的排队逻辑，让运行中的消息按顺序发送。')]),
    message('a1', 'assistant', [
      { type: 'reasoning', text: '先检查会话状态和队列入口，再验证执行完成时的出队行为。' },
      { type: 'tool', callId: 'c1', tool: 'Bash', state: { status: 'completed', title: '检查会话与队列入口', input: { command: 'rg -n "pendingQueue|sendNow" src/sessionController.ts' }, output: '327: async send(content, attachments)\n330: if (this.isBusy()) { ... }' } },
      { type: 'tool', callId: 'c2', tool: 'Edit', state: { status: 'completed', title: 'src/sessionController.ts', input: { file_path: 'src/sessionController.ts', old_string: 'await send(content);', new_string: 'await sendNow(content, attachments);' }, output: '文件已更新' } },
      text('已梳理发送路径。运行中的新消息会先进入队列，当前回合结束后再依次发送。\n\n```typescript\nif (this.isBusy()) {\n  this.pendingQueue.push({ content, attachments });\n  return;\n}\nawait this.sendNow(content, attachments);\n```\n\n可以继续检查**停止与插队**场景。')
    ])
  ];
  const makeSnapshot = (scene = 'chat', id = 's1') => ({
    session: { sessionId: id, createdAt: now, updatedAt: now, mode: 'build', status: 'idle', title: scene === 'empty' ? '' : '检查会话排队逻辑', workspace: { workspacePath: '/workspace/zcode-plugin' } },
    settings: { mode: { current: 'build' }, model: { available: models, current: { providerId: 'p', modelId: 'glm-5.3', options: { reasoningLevel: 'max' } } }, permission: { mode: 'build' } },
    projection: { sessionId: id, status: 'idle', mode: 'build', turnCount: 1, totalTokenCount: 18600, contextUsed: 18600, contextWindow: 1000000, pendingPermissions: [], activeToolCalls: [] },
    slashCommands: [{ name: 'help', description: '查看可用命令' }, { name: 'compact', description: '整理会话上下文' }],
    messages: scene === 'empty' ? [] : messages
  });
  const sessions = [
    { sessionId: 's1', title: '检查会话排队逻辑', updatedAt: now, mode: 'build', status: 'idle' },
    { sessionId: 's2', title: '修复工具调用与附件预览', updatedAt: now - 3600000, mode: 'edit', status: 'running' },
    { sessionId: 's3', title: '验证非常长的聊天标题在窄侧栏与历史搜索结果中的省略和可访问名称', updatedAt: now - 86400000, mode: 'plan', status: 'idle' }
  ];
  window.__sent = [];
  window.__fixture = {
    post, message, text, makeSnapshot,
    snapshot(scene = 'chat', id = 's1') { post({ kind: 'session-snapshot', data: makeSnapshot(scene, id) }); },
    status(status) { post({ kind: 'session-event', data: { type: 'session.updated', sessionId: 's1', payload: { status } } }); },
    context() { post({ kind: 'session-event', data: { type: 'session.updated', sessionId: 's1', payload: {
      usage: { totalTokens: 434000 }, contextWindow: 1000000,
      contextUsageBreakdown: [{ source: 'messages', chars: 348000 }, { source: 'mcp_tool_schemas', chars: 48000 }, { source: 'system_tool_schemas', chars: 27000 }, { source: 'skills', chars: 8000 }]
    } } }); },
    permission() { post({ kind: 'permission-request', data: {
      requestId: 'permission-1', sessionId: 's1', toolCallId: 'permission-tool', toolName: 'Bash', riskLevel: 'low',
      reason: '运行类型检查，验证本次变更', input: { command: 'npm run typecheck' },
      options: [
        { optionId: 'allow', kind: 'allow_once', name: '允许一次', response: { decision: 'allow' } },
        { optionId: 'deny', kind: 'deny_once', name: '拒绝', response: { decision: 'deny' } }
      ]
    } }); },
    question() { post({ kind: 'user-input-request', data: {
      requestId: 'question-1', sessionId: 's1', questions: [{ question: '下一步先检查哪条路径？', header: '验证路径',
        options: [{ label: '排队', value: 'queue' }, { label: '停止', value: 'stop' }] }]
    } }); },
    start() {
      post({ kind: 'bootstrap', data: { locale, workspacePath: '/workspace/zcode-plugin', environmentOk: true,
        account: { loggedIn: true, user: { email: 'ui-preview@z.ai' }, providerIds: ['p'] }, serverState: 'ready', defaultMode: 'build' } });
      this.snapshot(params.get('scene') || 'chat');
      document.getElementById('fire-ctx')?.addEventListener('click', () => this.context());
      document.getElementById('open-ctx')?.addEventListener('click', () => document.querySelector('.ctx-ring-btn').click());
      if (params.get('harness') === '0') document.getElementById('harness')?.remove();
    }
  };
  window.acquireVsCodeApi = () => ({
    getState: () => null, setState: () => {},
    postMessage(m) {
      window.__sent.push(m);
      queueMicrotask(() => {
        if (m.kind === 'list-sessions') post({ kind: 'sessions-list', data: { sessions } });
        if (m.kind === 'resume') window.__fixture.snapshot('chat', m.sessionId);
        if (m.kind === 'new-session') window.__fixture.snapshot('empty');
        if (m.kind === 'list-files') post({ kind: 'files-list', data: { dir: m.dir || '', entries: m.dir ? [{ name: 'chat.ts', kind: 'file' }] : [{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file' }] } });
        if (m.kind === 'attach-pick') post({ kind: 'attachments-picked', data: { attachments: [{ name: 'README.md', path: '/workspace/zcode-plugin/README.md', mime: 'text/markdown' }] } });
        if (m.kind === 'mcp-servers') post({ kind: 'mcp-servers', data: { running: true, servers: [{ name: 'codegraph', pid: 1234, source: 'workspace', connected: true }] } });
        if (m.kind === 'save-image') {
          if (window.__saveImage) void window.__saveImage(m);
          else post({ kind: 'image-saved', data: { path: `/tmp/${m.name}`, name: m.name, mime: 'image/png' } });
        }
      });
    }
  });
})();
