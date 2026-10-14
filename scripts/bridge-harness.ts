/**
 * [INPUT]: 消费 src/remote/{pairingManager,localServer,relayTypes}（不依赖 vscode）
 * [OUTPUT]: 无手机全链路桥接 harness（node 直跑）：真 PairingManager 注册 relay + 起本地 server bridge，
 *           首行输出 SID/HASH/MID 供终端模拟器（ZCode 仓库侧 harness）配对
 * [POS]: scripts 的端到端联调成员（手动运行，不入 CI）；配合 ZCode 仓库 packages/client 侧终端 harness 验证桥字节路径
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 用法：node out/scripts/bridge-harness.js [workspacePath] [serverPath]
 */
import { PairingManager } from '../src/remote/pairingManager';
import { spawnLocalServer } from '../src/remote/localServer';
import { createDeviceMid, createRelayPassHash, createRelayPassword } from '../src/remote/relayAuth';
import type { StoredPairingAuth } from '../src/remote';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const RUN_MS = Number(process.env.HARNESS_RUN_MS ?? 120_000);

async function main(): Promise<void> {
  const workspacePath = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'zcode-harness-ws-'));
  const serverPath = process.argv[3] ?? join(homedir(), '.zcode', 'vscode-remote', 'zcode-server.cjs');
  if (!existsSync(serverPath)) {
    console.error(`server 不存在: ${serverPath}`);
    process.exit(1);
  }
  const label = workspacePath.split('/').filter(Boolean).pop() ?? workspacePath;

  const deviceMid = process.env.HARNESS_MID ?? createDeviceMid('zcode-vscode-harness');
  const passHash = process.env.HARNESS_HASH ?? createRelayPassHash(createRelayPassword());
  const persistedSid = process.env.HARNESS_SID ?? '';
  let deviceSid = persistedSid;
  const storage: StoredPairingAuth = { deviceMid, deviceSid: persistedSid, passHash };

  const manager = new PairingManager({
    relayWsUrl: 'wss://zcode.z.ai/ws',
    deviceName: 'VSCode-harness',
    appVersion: process.env.HARNESS_VERSION ?? '0.0.0-harness',
    ...(process.env.HARNESS_NO_HEADER ? { sendDeviceIdHeader: false } : {}),
    spawnServer: (target) =>
      spawnLocalServer({
        nodeCommand: process.execPath,
        serverPath,
        cwd: target.workspacePath,
        env: {
          ZCODE_AGENT_SERVER_COMMAND: process.execPath,
          ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
            '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
            'app-server',
            '--stdio',
          ]),
        },
        clientVersion: '0.0.0-harness',
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    listWorkspaces: () => [{ workspacePath, label, kind: 'local' }],
    listTasks: () => [],
    storage: {
      load: async () => (deviceSid ? storage : undefined),
      save: async (auth) => {
        deviceSid = auth.deviceSid;
        storage.deviceSid = auth.deviceSid;
      },
      clear: async () => {},
    },
    onStatus: (status) => console.log(`[harness] status=${status.kind}${status.kind === 'error' ? ` (${status.message})` : ''}`),
    logger: { info: (...a) => console.log('[pairing]', ...a), warn: (...a) => console.warn('[pairing]', ...a), error: (...a) => console.error('[pairing]', ...a) },
  });
  await manager.start();

  // 等 sid 就位（注册 ack）后输出配对参数给终端模拟器
  const waitSid = setInterval(() => {
    if (deviceSid) {
      clearInterval(waitSid);
      console.log(`HARNESS_PAIR ${JSON.stringify({ deviceMid, deviceSid, passHash, workspacePath })}`);
    }
  }, 100);
  waitSid.unref();

  await new Promise((resolve) => setTimeout(resolve, RUN_MS));
  await manager.stop('harness-done');
  process.exit(0);
}

void main().catch((error) => {
  console.error(`harness 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
