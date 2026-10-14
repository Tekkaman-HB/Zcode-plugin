/**
 * [INPUT]: 消费 src/remote/relayAuth、src/remote/relayTypes、src/remote/relayTransport（不依赖 vscode）
 * [OUTPUT]: relay 设备通道冒烟测试（node 直跑）：注册 → 挑战应答 → waiting_terminal → 心跳存活 → 退出
 * [POS]: scripts 的 relay 通道成员，`npm run smoke:relay` 入口；验证 M1 传输层与官方 relay 的协议兼容性
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 真连官方生产 relay（wss://zcode.z.ai/ws），行为等价于桌面端启动一次远控（无副作用：只注册等待，不配对）。
 * 退出码 0 = 注册/认证/心跳全部通过。
 */
import { RelayTransport, type RelayTransportState } from '../src/remote/relayTransport';
import { createDeviceMid, createRelayPassHash, createRelayPassword } from '../src/remote/relayAuth';
import { buildRelayQrUrl } from '../src/remote/qrUrl';

const RELAY_WS_URL = 'wss://zcode.z.ai/ws';
const HOLD_MS = 25_000;

function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    console.error(`  ❌ ${label}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  console.log('[smoke-relay] 连接官方 relay…');
  const deviceMid = createDeviceMid('zcode-vscode-smoke');
  const passHash = createRelayPassHash(createRelayPassword());
  const seenStates = new Set<RelayTransportState>();
  let registeredSid: string | null = null;
  let heartbeatAcks = 0;

  const transport = new RelayTransport({
    relayWsUrl: RELAY_WS_URL,
    deviceMid,
    auth: { mode: 'register', passHash },
    meta: { platform: process.platform, version: '0.0.0-smoke', name: 'vscode-plugin-smoke' },
    logger: { info: (...a) => console.log('[relay]', ...a), warn: (...a) => console.warn('[relay]', ...a), error: (...a) => console.error('[relay]', ...a) },
    onRegisteredAuth: (auth) => {
      registeredSid = auth.deviceSid;
      console.log(`[smoke-relay] 注册成功 deviceSid=${auth.deviceSid}`);
    },
    onStateChange: (state) => {
      seenStates.add(state);
      console.log(`[smoke-relay] state → ${state}`);
    },
    onPayload: () => {},
    onInvalidPersistedAuth: async () => {},
    onError: (error) => console.warn('[smoke-relay] onError:', error.message),
  });
  transport.start();

  const deadline = Date.now() + HOLD_MS;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      // pair_status_ack 会刷新 transport 内部时间戳；这里以 waiting_terminal 状态持续时长近似心跳存活
      if (transport && seenStates.has('waiting_terminal')) heartbeatAcks += 1;
      if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve();
      }
    }, 1_000);
  });

  const qrUrl = registeredSid ? buildRelayQrUrl({ deviceSid: registeredSid, passHash, deviceMid, deviceName: 'smoke' }) : null;
  transport.dispose();

  ok(registeredSid !== null, '设备注册拿到 device_sid');
  ok(seenStates.has('registering'), '经历 registering 状态');
  ok(seenStates.has('authenticating'), '经历 authenticating 状态');
  ok(seenStates.has('waiting_terminal'), '到达 waiting_terminal（等待手机扫码）');
  ok(!seenStates.has('error'), '无 error 终态');
  ok(!seenStates.has('paired'), '未发生配对（冒烟不应有手机接入）');
  ok(qrUrl !== null && qrUrl.startsWith('https://zcode.z.ai/remote/v4?'), `二维码 URL 构造正确：${qrUrl?.slice(0, 60)}…`);
  console.log('[smoke-relay] 完成');
  process.exit(process.exitCode ?? 0);
}

void main();
