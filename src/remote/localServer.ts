/**
 * [INPUT]: 依赖 node:child_process/node:crypto、./ackRelayProtocol 的 ByteProtocol
 * [OUTPUT]: 对外提供 spawnLocalServer（spawn zcode-server.cjs → hello 握手 → 帧协议就绪）、LocalServerConnection
 * [POS]: src/remote 的本地服务宿主层——pairingManager 在 workspace-bridge-open 时消费；等价桌面为 SSH 远程拉起的 stdio server，
 *        但进程在本机、stdio 直连（无 SSH/WSL 中间层）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 *
 * 线协议（源码实证 packages/server/src/{entry-stdio,stdio}.ts + packages/rpc/src/protocol.ts）：
 *   1. server 启动即写一行 JSON：{"type":"zcode-hello","version",...}\n（stderr 是日志，stdout 只承载协议）
 *   2. client 回一行：{"type":"zcode-hello-ack","version","clientId"}\n（10s 超时）
 *   3. 之后全部字节为 13 字节帧头（type(1)|id(4)|ack(4)|length(4) 大端）+ body；仅 type=1(Regular) 上抛
 *   4. 帧层之上是 ChannelClient/ChannelServer 的 RPC 消息（与 relay rpc-frame 隧道的载荷同源）
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ByteProtocol } from './ackRelayProtocol';

const HEADER_SIZE = 13;
const MSG_TYPE_REGULAR = 1;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface LocalServerOptions {
  nodeCommand: string;
  serverPath: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  clientVersion: string;
  logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  onExit?(code: number | null, signal: NodeJS.Signals | null): void;
}

export interface LocalServerConnection {
  /** 消息字节级通道（内部完成 13 字节帧封装/解封），与 relay ack 协议同构对接 */
  readonly protocol: ByteProtocol;
  /** SIGTERM → 3s → SIGKILL */
  dispose(): void;
}

interface HelloMessage {
  type: 'zcode-hello';
  version: string;
  platform: string;
  arch: string;
  pid: number;
}

/** stdout 流式解析：hello 行 → 剩余字节进入帧装配器 */
class StdoutFrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private helloResolved = false;
  private readonly messageListeners = new Set<(bytes: Uint8Array) => void>();

  constructor(private readonly logger?: LocalServerOptions['logger']) {}

  addListener(listener: (bytes: Uint8Array) => void): { dispose(): void } {
    this.messageListeners.add(listener);
    return { dispose: () => this.messageListeners.delete(listener) };
  }

  /** 返回 null=尚未凑齐 hello 行 */
  consumeHelloChunk(chunk: Buffer): HelloMessage | null {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const newlineIdx = this.buffer.indexOf(0x0a);
    if (newlineIdx === -1) return null;
    const line = this.buffer.subarray(0, newlineIdx).toString('utf8').trim();
    this.buffer = this.buffer.subarray(newlineIdx + 1);
    this.helloResolved = true;
    this.drainFrames();
    try {
      const parsed = JSON.parse(line) as HelloMessage;
      if (parsed.type !== 'zcode-hello') throw new Error(`unexpected hello type: ${String(parsed.type)}`);
      return parsed;
    } catch (error) {
      this.logger?.warn('[local-server] invalid hello line', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  consumeChunk(chunk: Buffer): void {
    if (!this.helloResolved) throw new Error('frame chunk before hello resolved');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drainFrames();
  }

  private drainFrames(): void {
    for (;;) {
      if (this.buffer.byteLength < HEADER_SIZE) return;
      const type = this.buffer.readUInt8(0);
      const length = this.buffer.readUInt32BE(9);
      const totalFrameLength = HEADER_SIZE + length;
      if (this.buffer.byteLength < totalFrameLength) return; // body 未到齐不消费 header
      this.buffer = this.buffer.subarray(HEADER_SIZE);
      if (type === MSG_TYPE_REGULAR) {
        const body = this.buffer.subarray(0, length);
        // 拷贝出定长切片，避免持有整个增长缓冲
        const copy = new Uint8Array(body.byteLength);
        copy.set(body);
        for (const listener of this.messageListeners) listener(copy);
      }
      this.buffer = this.buffer.subarray(length);
    }
  }
}

export function spawnLocalServer(options: LocalServerOptions): Promise<LocalServerConnection> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.nodeCommand, [options.serverPath], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    let disposed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const reader = new StdoutFrameReader(options.logger);

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill('SIGKILL');
      reject(new Error(`zcode-server hello 握手超时（${HANDSHAKE_TIMEOUT_MS}ms）`));
    }, HANDSHAKE_TIMEOUT_MS);
    timeout.unref?.();

    function cleanup(): void {
      clearTimeout(timeout);
      child.stdout?.removeListener('data', onStdout);
      if (killTimer) clearTimeout(killTimer);
    }

    function onStdout(chunk: Buffer): void {
      if (settled) {
        reader.consumeChunk(chunk);
        return;
      }
      let hello: HelloMessage | null;
      try {
        hello = reader.consumeHelloChunk(chunk);
      } catch (error) {
        settled = true;
        cleanup();
        child.kill('SIGKILL');
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!hello) return;
      settled = true;
      clearTimeout(timeout);
      // 回 ack：一行 JSON，此后 stdin 全部是帧字节
      const ack = `${JSON.stringify({ type: 'zcode-hello-ack', version: options.clientVersion, clientId: randomUUID() })}\n`;
      child.stdin?.write(ack);
      options.logger?.info('[local-server] hello 完成', { serverVersion: hello.version, pid: hello.pid });
      resolve(connection);
    }

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', (chunk: Buffer) => {
      // server 日志走 stderr（stdout 专用于协议）；只转发不打状态机
      const text = chunk.toString('utf8').trim();
      if (text) options.logger?.info('[local-server:stderr]', text);
    });
    child.on('error', (error) => {
      if (settled) {
        options.logger?.warn('[local-server] spawn error', { message: error.message });
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`zcode-server 提前退出（code=${String(code)} signal=${String(signal)}），检查 serverPath 与 node 版本`));
        return;
      }
      options.onExit?.(code, signal);
    });

    function writeFrame(bytes: Uint8Array): void {
      if (disposed || child.stdin?.writable !== true) return;
      const header = Buffer.alloc(HEADER_SIZE);
      header.writeUInt8(MSG_TYPE_REGULAR, 0);
      header.writeUInt32BE(0, 1);
      header.writeUInt32BE(0, 5);
      header.writeUInt32BE(bytes.byteLength, 9);
      child.stdin.write(header);
      if (bytes.byteLength > 0) child.stdin.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    }

    const connection: LocalServerConnection = {
      protocol: {
        onMessage: (listener) => reader.addListener(listener),
        send: writeFrame,
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        cleanup();
        child.stdin?.end();
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          killTimer = undefined;
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 3_000);
        killTimer.unref?.();
      },
    };
  });
}
