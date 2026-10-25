/**
 * [INPUT]: node:fs/path/crypto、./gitChanges 的私有快照库；宿主提供真实回合发送/结束和会话切换边界
 * [OUTPUT]: SessionChanges、SessionReview；持久化回合增量与中间检查点，中断恢复已捕获结果，外部编辑冲突保守标记
 * [POS]: ui 的会话 diff 唯一状态源，独立于 webview 生命周期；changeReview 仅负责展示
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SnapshotStore, sameEntry, type SnapshotEntry, type SnapshotDiff, type SnapshotFiles } from './gitChanges';

interface FileRecord { base: SnapshotEntry | null; result: SnapshotEntry | null }
interface RecordData {
  version: 1; sessionId: string; workspace: string; partial: boolean;
  files: Record<string, FileRecord>; pending: string | null; excluded: string[]; error?: boolean; active?: boolean; capturing?: boolean;
}
export interface SessionReview {
  sessionId: string; status: 'ready' | 'missing' | 'partial' | 'error';
  files: SnapshotDiff[]; store: SnapshotStore | null;
}

const key = (value: string) => createHash('sha256').update(value).digest('hex');

export class SessionChanges {
  private selected: { id: string; workspace: string; history: boolean } | null = null;
  private records = new Map<string, RecordData>();
  private previews = new Map<string, RecordData>();
  private stores = new Map<string, SnapshotStore>();
  private listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  private storage: string;
  constructor(storage: string) { this.storage = path.resolve(storage); }
  /** 所有落盘路径必须位于 storage 根内：解析后越界一律拒绝 */
  private within(candidate: string): string {
    const resolved = path.resolve(candidate);
    if (resolved !== this.storage && !resolved.startsWith(this.storage + path.sep)) throw new Error('Snapshot path escaped storage root');
    return resolved;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void { if (!this.disposed) this.listeners.forEach(listener => listener()); }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => { /* 每次操作自身记录失败；下一会话不能被拒绝链阻塞。 */ });
    return result;
  }
  private recordKey(workspace: string, id: string): string { return key(workspace + '\0' + id); }
  private recordPath(workspace: string, id: string): string { return this.within(path.join(this.storage, this.recordKey(workspace, id) + '.json')); }

  private async store(workspace: string): Promise<SnapshotStore> {
    let store = this.stores.get(workspace);
    if (!store) {
      store = new SnapshotStore(this.within(path.join(this.storage, key(workspace), 'objects.git')));
      await store.initialize();
      this.stores.set(workspace, store);
    }
    return store;
  }
  private async load(workspace: string, id: string): Promise<RecordData | null> {
    const cacheKey = this.recordKey(workspace, id);
    const cached = this.records.get(cacheKey);
    if (cached) return cached;
    try {
      const record = JSON.parse(await fs.readFile(this.recordPath(workspace, id), 'utf8')) as RecordData;
      if (record.version !== 1 || record.workspace !== workspace || record.sessionId !== id) throw new Error('Invalid session snapshot');
      if (record.pending) {
        // 重载前未收齐结束边界：不能把重载后的任意工作区状态算作旧回合结果。
        record.pending = null; record.partial = true; record.error = true;
      }
      this.records.set(cacheKey, record);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async save(record: RecordData): Promise<void> {
    await fs.mkdir(this.storage, { recursive: true, mode: 0o700 });
    const file = this.recordPath(record.workspace, record.sessionId), temp = this.within(file + '.' + randomUUID());
    try {
      await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }); }
  }

  select(id: string | null, workspace: string, history = false): void {
    this.selected = id ? { id, workspace, history } : null;
    this.changed();
  }

  /** 所有实际发送（含队列出队）必须 await，保证 CLI 能写文件前基线已持久化。 */
  beginTurn(id: string, workspace: string): Promise<void> {
    return this.enqueue(async () => {
      let record: RecordData | null = null;
      try {
        record = await this.load(workspace, id) ?? {
          version: 1, sessionId: id, workspace, files: Object.create(null), pending: null, excluded: [],
          partial: this.selected?.id === id && this.selected.history
        };
        this.records.set(this.recordKey(workspace, id), record);
        // 再次实际发送却没有结束边界：旧回合不能被偷偷延长到新回合，重新取基线并标记缺口。
        if (record.pending) { record.pending = null; record.partial = true; record.error = true; }
        const overlapping = [...this.records.values()].filter(other => other !== record && other.workspace === workspace && other.pending && other.active);
        if (overlapping.length) {
          for (const other of [...overlapping, record]) {
            other.pending = null; other.partial = true; other.error = true;
            this.previews.delete(this.recordKey(other.workspace, other.sessionId));
            await this.save(other);
          }
          this.changed();
          return;
        }
        this.previews.delete(this.recordKey(workspace, id));
        record.active = false; record.capturing = true; record.excluded = [];
        const store = await this.store(workspace);
        record.pending = await store.capture(workspace);
        record.capturing = false;
        await this.save(record);
      } catch {
        if (record) { record.error = true; record.partial = true; record.pending = null; record.capturing = false; }
      }
      this.changed();
    });
  }

  cancelTurn(id: string, workspace?: string): Promise<void> {
    return this.enqueue(async () => {
      for (const record of this.records.values()) {
        if (record.sessionId !== id || (workspace && record.workspace !== workspace) || !record.pending) continue;
        record.pending = null;
        record.partial = true; record.error = true;
        this.previews.delete(this.recordKey(record.workspace, id));
        await this.save(record);
        this.changed();
      }
    }).catch(() => this.changed());
  }

  observe(event: { type: string; sessionId: string }): void {
    for (const record of this.records.values()) {
      if (record.sessionId !== event.sessionId) continue;
      if (!record.pending) {
        if (event.type === 'model.streaming' && !record.partial) {
          record.partial = true;
          void this.enqueue(async () => { await this.save(record); this.changed(); }).catch(() => this.changed());
        }
        continue;
      }
      if (event.type === 'model.streaming' || event.type === 'tool.updated') {
        record.active = true;
        const overlaps = [...this.records.values()].filter(other => other !== record && other.workspace === record.workspace && other.pending && other.active);
        if (overlaps.length) {
          const ambiguous = [...overlaps, record];
          for (const item of ambiguous) {
            item.pending = null; item.partial = true; item.error = true;
            this.previews.delete(this.recordKey(item.workspace, item.sessionId));
          }
          void this.enqueue(async () => { for (const item of ambiguous) await this.save(item); this.changed(); }).catch(() => this.changed());
          continue;
        }
      }
      if (event.type === 'turn.completed' || event.type === 'turn.failed') void this.checkpoint(event.sessionId, record.workspace, true);
      else if (event.type === 'tool.updated') this.scheduleCheckpoint(event.sessionId, record.workspace);
    }
  }

  scheduleCheckpoint(id: string, workspace: string): void {
    if (this.disposed) return;
    const timerKey = this.recordKey(workspace, id);
    const previous = this.timers.get(timerKey);
    if (previous) clearTimeout(previous);
    this.timers.set(timerKey, setTimeout(() => {
      this.timers.delete(timerKey);
      void this.checkpoint(id, workspace);
    }, 300));
  }

  /** 用户显式保存与模型写盘不可混算；本轮该路径保守排除，已有会话结果仍保留。 */
  externalSave(absolute: string): void {
    for (const record of this.records.values()) {
      if (!record.pending && !record.capturing) continue;
      const relative = path.relative(record.workspace, absolute);
      if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) continue;
      if (!record.excluded.includes(relative)) record.excluded.push(relative);
    }
  }

  checkpoint(id: string, workspace: string, final = false): Promise<void> {
    if (final) {
      const timerKey = this.recordKey(workspace, id), timer = this.timers.get(timerKey);
      if (timer) clearTimeout(timer);
      this.timers.delete(timerKey);
    }
    return this.enqueue(async () => {
      const record = await this.load(workspace, id);
      if (!record?.pending) return;
      try {
        const store = await this.store(workspace);
        const before = await store.files(record.pending), after = await store.files(await store.capture(workspace));
        const next: RecordData = { ...record, files: Object.assign(Object.create(null), record.files), partial: record.partial || record.excluded.length > 0 };
        for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
          const base = before[file] ?? null, result = after[file] ?? null;
          if (sameEntry(base, result) || record.excluded.includes(file)) continue;
          const previous = Object.hasOwn(record.files, file) ? record.files[file] : undefined;
          if (!previous) next.files[file] = { base, result };
          else if (sameEntry(previous.result, base)) next.files[file] = { base: previous.base, result };
          else if (previous.result && base && result) {
            const merged = await store.merge(previous.result, base, result);
            if (merged) next.files[file] = { base: previous.base, result: merged };
            else next.partial = true;
          } else next.partial = true;
        }
        for (const [file, change] of Object.entries(next.files)) if (sameEntry(change.base, change.result)) delete next.files[file];
        if (final) next.pending = null;
        // 中间检查点也落盘；中断恢复仅取已捕获结果，运行中仍按原基线计算整轮增量。
        await this.save(next);
        if (final) {
          this.records.set(this.recordKey(workspace, id), next);
          this.previews.delete(this.recordKey(workspace, id));
        } else this.previews.set(this.recordKey(workspace, id), next);
      } catch {
        if (final) {
          this.previews.delete(this.recordKey(workspace, id));
          record.error = true; record.partial = true; record.pending = null;
          await this.save(record).catch(() => {});
        } else this.previews.set(this.recordKey(workspace, id), { ...record, error: true, partial: true });
      }
      this.changed();
    }).catch(() => this.changed());
  }

  get currentSessionId(): string | null { return this.selected?.id ?? null; }

  async review(): Promise<SessionReview> {
    await this.queue;
    const selected = this.selected;
    if (!selected) return { sessionId: '', status: 'ready', files: [], store: null };
    try {
      const cached = await this.load(selected.workspace, selected.id);
      const record = this.previews.get(this.recordKey(selected.workspace, selected.id)) ?? cached;
      if (!record) return { sessionId: selected.id, status: selected.history ? 'missing' : 'ready', files: [], store: null };
      const store = await this.store(selected.workspace);
      const before: SnapshotFiles = Object.create(null), after: SnapshotFiles = Object.create(null);
      for (const [file, change] of Object.entries(record.files)) {
        if (change.base) before[file] = change.base;
        if (change.result) after[file] = change.result;
      }
      const files = await store.diff(before, after);
      return { sessionId: selected.id, status: record.error && !files.length ? 'error' : record.partial ? 'partial' : 'ready', files, store };
    } catch { return { sessionId: selected.id, status: 'error', files: [], store: null }; }
  }

  dispose(): void {
    this.disposed = true; this.listeners.clear();
    this.timers.forEach(timer => clearTimeout(timer)); this.timers.clear();
  }
}
