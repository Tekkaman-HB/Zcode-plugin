/**
 * [INPUT]: vscode、./snapshotDocuments 的持久只读 URI、./sessionChanges 与 ./bridge 的摘要契约
 * [OUTPUT]: ChangeReview，直接打开当前会话的多文件 diff 编辑器及摘要推送；释放侧栏订阅不释放快照资源
 * [POS]: ui 的会话 diff 展示适配；数据归属/持久化由 SessionChanges 负责，不读取工作区差异
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import * as vscode from 'vscode';
import { snapshotUri } from './snapshotDocuments';
import { SessionChanges, type SessionReview } from './sessionChanges';
import type { SessionChangesPayload } from './bridge';

export class ChangeReview implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private disposed = false;
  private readonly zh: boolean;

  constructor(private sessions: SessionChanges, locale: string,
    private publish: (data: SessionChangesPayload) => void) {
    this.zh = locale === 'zh-CN';
    const unsubscribe = sessions.subscribe(() => { void this.refresh(); });
    this.disposables.push({ dispose: unsubscribe });
  }

  private summary(review: SessionReview): void {
    if (this.disposed) return;
    const files = review.files;
    this.publish({ sessionId: review.sessionId, status: review.status, files: files.length,
      added: files.reduce((n, file) => n + file.added, 0), deleted: files.reduce((n, file) => n + file.deleted, 0),
      binary: files.filter(file => file.binary).length });
  }

  async refresh(): Promise<void> { this.summary(await this.sessions.review()); }

  async review(): Promise<void> {
    const review = await this.sessions.review();
    this.summary(review);
    if (this.disposed) return;
    if (!review.files.length || !review.store) {
      void vscode.window.showInformationMessage(this.zh
        ? review.status === 'ready' ? '本会话尚未记录文件变更。' : '本会话缺少可靠的差异记录，不显示整个工作区的改动。'
        : review.status === 'ready' ? 'No recorded changes in this session.' : 'Reliable session changes are unavailable. Workspace changes are excluded.');
      return;
    }
    if (review.sessionId !== this.sessions.currentSessionId) return;
    const store = review.store;
    const resources = review.files.map(file => {
      const original = snapshotUri(store, review.sessionId, file.path, file.before, 'before');
      const modified = snapshotUri(store, review.sessionId, file.path, file.after, 'after');
      return [modified ?? original!, original, modified];
    });
    await vscode.commands.executeCommand('vscode.changes',
      `ZCode · ${this.zh ? '会话变更' : 'Session changes'} · ${review.sessionId.slice(0, 8)}`, resources);
  }

  dispose(): void {
    this.disposed = true;
    this.disposables.forEach(disposable => disposable.dispose());
  }
}
