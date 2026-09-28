/**
 * [INPUT]: 依赖 node:child_process / node:events，消费 ./types 的传输层类型
 * [OUTPUT]: 对外提供 RpcClient（NDJSON JSON-RPC 双向客户端）与 RpcSpawnOptions；失败统一经 exitPromise 单路径上报，不发射 error 事件
 * [POS]: protocol 的传输核心，被 serverManager.ts 持有，一切方法调用与事件流的通道
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type {
  RpcNotification,
  RpcServerRequest
} from './types';

export interface RpcSpawnOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

type ReverseHandler = (method: string, params: unknown) => Promise<unknown> | unknown;

export class RpcClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = '';
  private disposed = false;
  /** 反向请求路由：method → handler；未注册的方法返回 -32601 错误 */
  reverseRouter: ReverseHandler | undefined;

  readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  private constructor(proc: ChildProcessWithoutNullStreams) {
    super();
    this.proc = proc;
    this.exitPromise = new Promise((resolve) => {
      proc.once('exit', (code, signal) => resolve({ code, signal }));
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line) this.emit('stderr', line);
    });
    proc.once('exit', (code, signal) => {
      const err = new Error(`app-server exited (code=${code}, signal=${signal})`);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });
    // 写失败（EPIPE 等）必须有人接住——stream 无 error 监听同样会崩进程；
    // 但禁止再 emit：进程死亡由 exitPromise 单路径上报（无监听的 'error' 事件会崩扩展宿主）
    proc.stdin.on('error', () => { /* 静默：见上 */ });
  }

  static spawn(opts: RpcSpawnOptions): RpcClient {
    const proc = spawn(opts.command, opts.args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }) as ChildProcessWithoutNullStreams;
    return new RpcClient(proc);
  }

  /** 客户端 → 服务端请求 */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.disposed || this.proc.exitCode !== null || this.proc.killed) {
        reject(new Error('app-server is not running'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer
      });
      this.write({ id, method, params });
    });
  }

  /** 应答服务端反向请求 */
  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  kill(): void {
    this.disposed = true;
    if (this.proc.exitCode === null && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      setTimeout(() => {
        if (this.proc.exitCode === null && !this.proc.killed) this.proc.kill('SIGKILL');
      }, 3000).unref();
    }
  }

  private write(msg: unknown): void {
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    } catch {
      // 同步写失败静默：进程死亡由 exitPromise 上报，pending 请求由超时兜底
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 非 JSON 行（对齐 NDJSON 容错）直接跳过
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined) {
        // 服务端反向请求
        const req = msg as unknown as RpcServerRequest;
        void this.handleReverse(req);
      } else {
        this.emit('notification', msg as unknown as RpcNotification);
      }
      return;
    }
    if (msg.id !== undefined && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      const err = msg.error as { code: number; message: string } | undefined;
      if (err) p.reject(new Error(`${err.message} (code ${err.code})`));
      else p.resolve(msg.result);
    }
  }

  private async handleReverse(req: RpcServerRequest): Promise<void> {
    try {
      if (!this.reverseRouter) throw new Error('no reverse router');
      const result = await this.reverseRouter(req.method, req.params);
      this.respond(req.id, result ?? {});
    } catch (e) {
      this.respondError(req.id, -32601, `ZCode VSCode cannot handle ${req.method}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
