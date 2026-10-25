/**
 * [INPUT]: vscode、node:path、./gitChanges 的私有快照对象库；URI 携带工作区键/会话/不可变 blob
 * [OUTPUT]: SnapshotDocuments 只读 FileSystemProvider 与 snapshotUri；按需读取文本/二进制和文件大小
 * [POS]: ui 的原生 diff 资源层，extension 生命周期注册；不依赖侧栏或内存原文，重开 URI 可从磁盘恢复
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { SnapshotStore, type SnapshotEntry } from './gitChanges';

export const SNAPSHOT_SCHEME = 'zcode-snapshot';

export function snapshotUri(store: SnapshotStore, sessionId: string, file: string, entry: SnapshotEntry | null, side: 'before' | 'after'): vscode.Uri | undefined {
  if (!entry) return undefined;
  return vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: '/' + file,
    query: new URLSearchParams({ workspace: path.basename(path.dirname(store.directory)), blob: entry.hash, session: sessionId, side }).toString() });
}

export class SnapshotDocuments implements vscode.FileSystemProvider, vscode.Disposable {
  private events = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.events.event;
  private registration: vscode.Disposable;
  private sizes = new Map<string, Promise<number>>();

  constructor(private storage: string) {
    this.registration = vscode.workspace.registerFileSystemProvider(SNAPSHOT_SCHEME, this, { isReadonly: true, isCaseSensitive: true });
  }

  private resolve(uri: vscode.Uri): { store: SnapshotStore; entry: SnapshotEntry } {
    const query = new URLSearchParams(uri.query), blob = query.get('blob') ?? '', workspace = query.get('workspace') ?? '';
    if (uri.scheme !== SNAPSHOT_SCHEME || !/^[a-f0-9]{64}$/.test(workspace) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blob)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return { store: new SnapshotStore(path.join(this.storage, workspace, 'objects.git')), entry: { hash: blob, mode: '100644' } };
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { store, entry } = this.resolve(uri);
    const key = store.directory + ':' + entry.hash;
    let size = this.sizes.get(key);
    if (!size) {
      size = store.size(entry).catch(() => { this.sizes.delete(key); throw vscode.FileSystemError.FileNotFound(uri); });
      this.sizes.set(key, size);
    }
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: await size, permissions: vscode.FilePermission.Readonly };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { store, entry } = this.resolve(uri);
    try { return await store.content(entry); }
    catch { throw vscode.FileSystemError.FileNotFound(uri); }
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] { throw vscode.FileSystemError.FileNotFound(uri); }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions(); }
  writeFile(): void { throw vscode.FileSystemError.NoPermissions(); }
  delete(): void { throw vscode.FileSystemError.NoPermissions(); }
  rename(): void { throw vscode.FileSystemError.NoPermissions(); }

  dispose(): void { this.registration.dispose(); this.events.dispose(); this.sizes.clear(); }
}
