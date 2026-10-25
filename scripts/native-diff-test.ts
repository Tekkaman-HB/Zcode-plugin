/**
 * [INPUT]: 真实 vscode API、临时 Git 工作区、SessionChanges/ChangeReview/SnapshotDocuments；由 native-diff-check 启动
 * [OUTPUT]: run，验证专用 diff 的原生标签、只读资源、增删文件、侧栏释放/资源重新注册，并通知截图驱动
 * [POS]: scripts/ 的独立 Extension Development Host 测试入口，无账户/模型请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SessionChanges } from '../src/ui/sessionChanges';
import { ChangeReview } from '../src/ui/changeReview';
import { SnapshotDocuments, snapshotUri, SNAPSHOT_SCHEME } from '../src/ui/snapshotDocuments';

export async function run(): Promise<void> {
  // 测试根目录由 native-diff-check.mjs 的 mkdtemp 生成：显式校验绝对路径，派生路径必须落在根内
  const envRoot = process.env.ZCODE_DIFF_TEST_ROOT;
  assert(typeof envRoot === 'string' && path.isAbsolute(envRoot), 'ZCODE_DIFF_TEST_ROOT must be an absolute path');
  const root = path.resolve(envRoot);
  const within = (target: string) => target === root || target.startsWith(root + path.sep);
  const workspace = path.join(root, 'workspace'), storage = path.join(root, 'storage');
  assert(within(workspace) && within(storage), 'derived paths must stay under ZCODE_DIFF_TEST_ROOT');
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  await fs.writeFile(path.join(workspace, 'modified.ts'), 'export const value = "session_before_marker";\n');
  await fs.writeFile(path.join(workspace, 'deleted.ts'), 'export const removed = true;\n');
  const sessions = new SessionChanges(storage);
  sessions.select('native-session', workspace);
  await sessions.beginTurn('native-session', workspace);
  await fs.writeFile(path.join(workspace, 'modified.ts'), 'export const value = "session_after_marker";\n');
  await fs.unlink(path.join(workspace, 'deleted.ts'));
  await fs.writeFile(path.join(workspace, 'added.ts'), 'export const added = true;\n');
  await sessions.checkpoint('native-session', workspace, true);
  const review = new ChangeReview(sessions, 'zh-CN', () => {});
  let documents = new SnapshotDocuments(storage);
  try {
    await review.review();
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => tab.label));
    assert.ok(tabs.some(label => label.includes('ZCode') && label.includes('会话变更')), JSON.stringify(tabs));
    assert.equal(vscode.workspace.fs.isWritableFileSystem(SNAPSHOT_SCHEME), false);
    const recorded = await sessions.review();
    assert.equal(recorded.files.length, 3);
    const changed = recorded.files.find(file => file.path === 'modified.ts')!;
    const before = snapshotUri(recorded.store!, recorded.sessionId, changed.path, changed.before, 'before')!;
    const after = snapshotUri(recorded.store!, recorded.sessionId, changed.path, changed.after, 'after')!;
    assert.ok((await vscode.workspace.openTextDocument(before)).getText().includes('session_before_marker'));
    assert.ok((await vscode.workspace.openTextDocument(after)).getText().includes('session_after_marker'));
    review.dispose();
    assert.ok(Buffer.from(await vscode.workspace.fs.readFile(after)).toString().includes('session_after_marker'));
    documents.dispose(); documents = new SnapshotDocuments(storage);
    assert.ok(Buffer.from(await vscode.workspace.fs.readFile(before)).toString().includes('session_before_marker'));
    await assert.rejects(async () => { await vscode.workspace.fs.writeFile(after, Buffer.from('must not change')); });
    await fs.writeFile(path.join(root, 'ready.json'), JSON.stringify({ tabs, inputs: vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({ type: tab.input?.constructor.name, keys: Object.keys(tab.input ?? {}) }))), resources: recorded.files.map(file => file.path), readonly: true }));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try { await fs.access(path.join(root, 'continue')); return; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    throw new Error('Native screenshot driver timed out');
  } catch (error) {
    await fs.writeFile(path.join(root, 'failure.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
    throw error;
  } finally { review.dispose(); documents.dispose(); sessions.dispose(); }
}
