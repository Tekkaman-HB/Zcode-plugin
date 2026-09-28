/**
 * [INPUT]: 消费 src/environment、src/account、src/protocol/*（不依赖 vscode）
 * [OUTPUT]: 协议冒烟测试（node 直跑）：spawn → 推账户 → 建会话 → 发消息 → 权限应答 → 断言
 * [POS]: scripts 的唯一成员，`npm run smoke` 入口；CI/回归时验证 CLI 协议未漂移
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 运行前提：本机已安装 ZCode 桌面端且已登录（~/.zcode/v2/credentials.json 存在）。
 * 退出码 0 = 全部通过；非 0 = 有断言失败（输出会标明阶段）。
 */
import { resolveEnvironment } from '../src/environment';
import { buildAccountSnapshot } from '../src/account';
import { decryptCredentials, getProviderApiKey } from '../src/credentials';
import { RpcClient } from '../src/protocol/rpc';
import type {
  SessionCreateResult,
  SessionEvent,
  SessionSubscribeResult,
  PermissionRequestParams,
  RuntimePrefsParams
} from '../src/protocol/types';

const TIMEOUT_MS = 180_000;

function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    console.error(`  ❌ ${label}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  console.log('── ZCode 协议冒烟测试 ──');
  const env = resolveEnvironment();
  ok(env.cliExists, `CLI 存在: ${env.cliPath}`);
  ok(env.builtinRevision !== null, `内置 revision 指纹: ${env.builtinRevision}`);
  if (!env.cliExists || !env.builtinRevision) return;

  const built = buildAccountSnapshot(env.builtinConfigPath, env.credentialsPath, env.settingPath, env.builtinRevision);
  ok(built.snapshot !== null, `账户快照构建（providers: ${Object.keys(built.snapshot?.providers ?? {}).join(', ') || '无'}）`);
  ok(built.status.loggedIn, `登录态: ${built.status.loggedIn}（${built.status.user?.email ?? 'email 未知'}）`);
  if (!built.snapshot) return;

  // ── spawn ──
  const rpc = RpcClient.spawn({
    command: env.nodeCommand,
    args: [env.cliPath, 'app-server', '--stdio'],
    env: {
      ...process.env,
      ...env.nodeExtraEnv,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: env.builtinConfigPath,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: env.personalConfigPath
    } as Record<string, string>,
    cwd: process.cwd()
  });

  const events: SessionEvent[] = [];
  let permissionSeen: PermissionRequestParams | null = null;
  let assistantText = '';
  rpc.on('notification', (n) => {
    if (n.method === 'session/event') {
      const ev = n.params as SessionEvent;
      events.push(ev);
      const payload = (ev as unknown as { payload?: Record<string, unknown> }).payload ?? ev;
      const delta = (payload as unknown as { delta?: string }).delta;
      if (ev.type === 'model.streaming' && typeof delta === 'string') {
        assistantText += delta;
      }
      if (process.env.SMOKE_VERBOSE) console.log('  [event]', ev.type, Object.keys(payload).join(','));
    }
  });
  rpc.on('stderr', (line) => {
    if (process.env.SMOKE_VERBOSE) console.log('  [stderr]', line.slice(0, 200));
  });
  rpc.reverseRouter = (method, params) => {
    if (method === 'session/requestRuntimePreferences') {
      const p = params as RuntimePrefsParams;
      const base = {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: 'preflight-v1' as const
      };
      return p.scope === 'user-execution' ? { ...base, integratedTerminalShell: { mode: 'auto' } } : base;
    }
    if (method === 'interaction/requestPermission') {
      permissionSeen = params as PermissionRequestParams;
      console.log(`  ⚙ 权限请求: ${permissionSeen.toolName} (${permissionSeen.riskLevel})，选项: ${permissionSeen.options.map((o) => o.name).join(' / ')}`);
      // 选第一个 allow 决策的选项
      const allow = permissionSeen.options.find((o) => o.response.decision === 'allow') ?? permissionSeen.options[0];
      return allow.response;
    }
    if (method === 'interaction/requestUserInput') {
      return { requestId: (params as { requestId: string }).requestId, cancelled: true };
    }
    if (method === 'interaction/requestProviderRuntimeHeaders') {
      const req = params as { providerId?: string; modelSelection?: { providerId?: string } };
      const providerId = req.providerId ?? req.modelSelection?.providerId ?? '';
      const creds = decryptCredentials(env.credentialsPath);
      const apiKey = creds ? getProviderApiKey(creds, providerId) : null;
      ok(Boolean(apiKey), `认证反向请求可应答（provider=${providerId}）`);
      return apiKey
        ? { headersApplied: true, requestAuth: { apiKey } }
        : { headersApplied: false, errorMessage: 'no credential' };
    }
    throw new Error(`unhandled reverse request: ${method}`);
  };

  // ── 账户推送 ──
  const push = await rpc.request<{ status: string }>('provider/updateAccountConfig', built.snapshot, 30_000);
  ok(push.status === 'received', `账户推送: ${push.status}`);

  // ── 建会话（build 模式以触发权限流） ──
  const ws = process.cwd();
  const created = await rpc.request<SessionCreateResult>('session/create', {
    workspace: { workspacePath: ws, workspaceKey: ws },
    mode: 'build'
  }, 60_000);
  const sessionId = created.session?.sessionId;
  ok(Boolean(sessionId), `会话创建: ${sessionId}`);
  const models = created.settings?.model?.available ?? [];
  ok(models.length > 0, `模型可用: ${models.map((m) => m.label).join(', ')}`);
  if (!sessionId) {
    rpc.kill();
    return;
  }

  // ── 订阅活流（desktop-continuous 是桌面端同款投递模式） ──
  const sub = await rpc.request<SessionSubscribeResult>('session/subscribe', {
    sessionId,
    deliveryKind: 'desktop-continuous'
  }, 15_000);
  for (const ev of sub.events ?? []) events.push(ev);

  // ── 发消息（要求用 Bash → build 模式必触发权限） ──
  console.log('  … 发送 prompt（等待模型 + 权限流）');
  const sendResult = await rpc.request<{ accepted: boolean }>('session/send', {
    sessionId,
    content: '请用 Write 工具在当前目录创建文件 zcode-smoke-marker.txt，内容为 zcode-smoke-ok。然后告诉我完成了。不要做其他事。'
  }, 30_000);
  ok(sendResult.accepted === true, '消息已受理');

  // ── 等待回合结束或超时 ──
  const deadline = Date.now() + TIMEOUT_MS;
  let turnDone: 'completed' | 'failed' | null = null;
  while (Date.now() < deadline && turnDone === null) {
    await sleep(500);
    for (let i = events.length - 1; i >= 0; i--) {
      const t = events[i].type;
      if (t === 'turn.completed') { turnDone = 'completed'; break; }
      if (t === 'turn.failed') { turnDone = 'failed'; break; }
    }
    // 权限请求兜底：路由器已同步应答
  }
  ok(turnDone === 'completed', `回合结束: ${turnDone ?? '超时'}`);
  ok(permissionSeen !== null, '权限请求已到达并应答');
  ok(assistantText.length > 0, `助手流式输出 ${assistantText.length} 字符`);
  ok(assistantText.includes('zcode-smoke-ok') || assistantText.includes('完成'), '助手输出包含结果');
  console.log(`  ┌ 助手输出片段: ${assistantText.slice(0, 200).replace(/\n/g, ' ')}`);

  // ── 会话列表 ──
  const list = await rpc.request<{ sessions: { sessionId: string }[] }>('session/list', {}, 15_000);
  ok(list.sessions.some((s) => s.sessionId === sessionId), `session/list 含新会话（共 ${list.sessions.length} 条）`);

  rpc.kill();
  console.log('── 冒烟测试结束 ──');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('冒烟测试异常:', e);
  process.exit(1);
});
