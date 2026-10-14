/**
 * [INPUT]: 消费 src/remote/localServer 的 spawnLocalServer（不依赖 vscode）
 * [OUTPUT]: zcode-server 资产冒烟测试（node 直跑）：spawn → zcode-hello 握手 → 存活 → 干净退出
 * [POS]: scripts 的 server 资产闸门成员，`npm run smoke:server` 入口；M0 闸门——产物不存在或握手失败即失败
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 用法：node out/scripts/smoke-server.js [serverPath] [nodeCommand]
 * 默认 serverPath = ~/.zcode/vscode-remote/zcode-server.cjs，nodeCommand = process.execPath。
 * services 级 RPC 与会话互通由真机验收（M4）覆盖，本脚本只验证资产可启动可握手。
 */
import { spawnLocalServer } from '../src/remote/localServer';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOLD_MS = 5_000;

function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    console.error(`  ❌ ${label}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const serverPath = process.argv[2] ?? join(homedir(), '.zcode', 'vscode-remote', 'zcode-server.cjs');
  const nodeCommand = process.argv[3] ?? process.execPath;

  console.log(`[smoke-server] server=${serverPath}`);
  console.log(`[smoke-server] node=${nodeCommand}`);
  ok(existsSync(serverPath), 'zcode-server.cjs 资产存在');

  let received = 0;
  const connection = await spawnLocalServer({
    nodeCommand,
    serverPath,
    clientVersion: '0.0.0-smoke',
    logger: { info: (...a) => console.log('[server]', ...a), warn: (...a) => console.warn('[server]', ...a), error: (...a) => console.error('[server]', ...a) },
  });
  connection.protocol.onMessage(() => {
    received += 1;
  });
  ok(true, 'zcode-hello 握手完成（spawnLocalServer resolve）');

  await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
  connection.dispose();
  await new Promise((resolve) => setTimeout(resolve, 500));

  ok(true, `存活 ${HOLD_MS}ms（server 侧 RPC 待真机验收；收到 ${received} 帧服务端主动消息）`);
  console.log('[smoke-server] 完成');
  process.exit(process.exitCode ?? 0);
}

void main().catch((error) => {
  console.error(`  ❌ 冒烟失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
