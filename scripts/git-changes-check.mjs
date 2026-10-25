/**
 * [INPUT]: node:test/assert/fs/os/child_process、esbuild 与真实 Git；消费 sessionChanges/gitChanges/宿主/控制器
 * [OUTPUT]: 临时仓库会话归属回归，覆盖多轮/隔离/检查点中断恢复/外部编辑/冲突/只读快照与真实发送边界
 * [POS]: scripts/ 的 diff 验收层，不读取项目文件内容、不改当前项目 Git 状态，无模型调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-session-test-')));
try {
  const output = path.join(temp, 'checks.mjs');
  await build({ stdin: { contents: `
    export { SessionChanges } from './src/ui/sessionChanges';
    export { ChangeReview } from './src/ui/changeReview';
    export { SnapshotDocuments } from './src/ui/snapshotDocuments';
    export { ChatViewProvider } from './src/ui/chatProvider';
    export { SessionController } from './src/sessionController';
    export { state as testState } from 'vscode';`, resolveDir: process.cwd() },
    bundle: true, outfile: output, platform: 'node', format: 'esm', plugins: [{ name: 'vscode-double', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
        export const state = { commands: [], notices: [], provider: null };
        const uri = fields => ({ ...fields, fsPath: fields.path, toString() { return this.scheme + ':' + this.path + '?' + (this.query || ''); } });
        export const Uri = { file: path => uri({ scheme: 'file', path }), from: uri };
        export const env = { language: 'zh-CN' };
        export const FileType = { File: 1, Directory: 2 };
        export const FilePermission = { Readonly: 1 };
        export class Disposable { constructor(fn) { this.dispose = fn; } }
        export class EventEmitter { event = () => new Disposable(() => {}); dispose() {} }
        export class FileSystemError extends Error {
          static FileNotFound() { return Object.assign(new Error('FileNotFound'), { code: 'FileNotFound' }); }
          static NoPermissions() { return Object.assign(new Error('NoPermissions'), { code: 'NoPermissions' }); }
        }
        export const workspace = {
          registerFileSystemProvider(scheme, provider, options) { state.provider = provider; state.options = options; return { dispose() { state.provider = null; } }; },
        };
        export const window = {
          showInformationMessage: text => { state.notices.push(text); }
        };
        export const commands = { executeCommand: async (...args) => { state.commands.push(args); } };
      ` }));
    } }] });
  const { SessionChanges, ChangeReview, SnapshotDocuments, ChatViewProvider, SessionController, testState } = await import(output);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  let sequence = 0;
  const save = (dir, file, data) => fs.writeFile(path.join(dir, file), data);
  const commit = dir => { git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'baseline'); };
  async function fixture() {
    const base = path.join(temp, String(++sequence)), workspace = path.join(base, 'workspace'), storage = path.join(base, 'storage');
    await fs.mkdir(workspace, { recursive: true }); git(workspace, 'init', '-q');
    git(workspace, 'config', 'user.email', 'test@localhost'); git(workspace, 'config', 'user.name', 'Test'); git(workspace, 'config', 'commit.gpgsign', 'false');
    const sessions = new SessionChanges(storage); sessions.select('s1', workspace);
    return { workspace, storage, sessions };
  }
  async function contents(review, file = review.files[0]) {
    return [await review.store.content(file.before), await review.store.content(file.after)].map(buffer => buffer.toString());
  }
  async function turn(sessions, workspace, action, id = 's1') {
    await sessions.beginTurn(id, workspace); await action(); await sessions.checkpoint(id, workspace, true);
    return sessions.review();
  }

  await test('会话基线包含原有暂存/未暂存/新增内容，只统计本轮增量', async () => {
    const { workspace: w, sessions: s } = await fixture();
    await save(w, 'file', 'HEAD\n'); commit(w);
    await save(w, 'file', 'staged\n'); git(w, 'add', '.'); await save(w, 'file', 'preexisting\n');
    await save(w, 'existing-new', 'outside\n');
    assert.equal((await s.review()).files.length, 0);
    const r = await turn(s, w, () => save(w, 'file', 'session\n'));
    assert.equal(r.status, 'ready'); assert.equal(r.files.length, 1);
    assert.equal(r.files[0].added, 1); assert.equal(r.files[0].deleted, 1);
    assert.deepEqual(await contents(r), ['preexisting\n', 'session\n']); s.dispose();
  });
  await test('多轮同一文件合并为最终差异，改回基线后不残留', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'file', 'one\n');
    await turn(s, w, () => save(w, 'file', 'two\n'));
    const r = await turn(s, w, () => save(w, 'file', 'three\nfour\n'));
    assert.equal(r.files.length, 1); assert.equal(r.files[0].added, 2);
    assert.deepEqual(await contents(r), ['one\n', 'three\nfour\n']);
    assert.equal((await turn(s, w, () => save(w, 'file', 'one\n'))).files.length, 0); s.dispose();
  });
  await test('切换会话只显示各自快照，空闲时外部改动不改变记录', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'file', 'original\n');
    await turn(s, w, () => save(w, 'file', 'session A\n'));
    s.select('s2', w); assert.equal((await s.review()).files.length, 0);
    await turn(s, w, () => save(w, 'file', 'session B\n'), 's2');
    assert.deepEqual(await contents(await s.review()), ['session A\n', 'session B\n']);
    await save(w, 'file', 'external\n'); s.select('s1', w, true);
    assert.deepEqual(await contents(await s.review()), ['original\n', 'session A\n']); s.dispose();
  });
  await test('重载后恢复同一会话记录，项目提交/删除不改变快照', async () => {
    const { workspace: w, storage, sessions: s } = await fixture(); await save(w, 'file', 'before\n');
    await turn(s, w, () => save(w, 'file', 'after\n')); s.dispose(); commit(w); await fs.unlink(path.join(w, 'file'));
    const restored = new SessionChanges(storage); restored.select('s1', w, true);
    const r = await restored.review(); assert.equal(r.status, 'ready');
    assert.deepEqual(await contents(r), ['before\n', 'after\n']); restored.dispose();
  });
  await test('轮次之间同文件的外部修改被三方合并排除', async () => {
    const { workspace: w, sessions: s } = await fixture();
    const initial = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    await save(w, 'file', initial.join('\n') + '\n');
    const first = [...initial]; first[1] = 'session first';
    await turn(s, w, () => save(w, 'file', first.join('\n') + '\n'));
    const outside = [...first]; outside[14] = 'external manual'; await save(w, 'file', outside.join('\n') + '\n');
    await save(w, 'external-file', 'manual\n');
    const second = [...outside]; second[28] = 'session second';
    const r = await turn(s, w, () => save(w, 'file', second.join('\n') + '\n'));
    const [, after] = await contents(r);
    assert.equal(r.status, 'ready'); assert.equal(r.files.length, 1);
    assert.ok(after.includes('session first') && after.includes('session second'));
    assert.ok(!after.includes('external manual')); s.dispose();
  });
  await test('同一行发生外部编辑冲突时保留已确认记录，显式标记部分记录', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'file', 'original\n');
    await turn(s, w, () => save(w, 'file', 'session first\n')); await save(w, 'file', 'external\n');
    const r = await turn(s, w, () => save(w, 'file', 'session second\n'));
    assert.equal(r.status, 'partial'); assert.deepEqual(await contents(r), ['original\n', 'session first\n']); s.dispose();
  });
  await test('执行期间用户保存的路径不混入，其他模型更改仍可审查', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'a', 'before\n'); await save(w, 'b', 'before\n');
    const r = await turn(s, w, async () => {
      await save(w, 'a', 'user\n'); s.externalSave(path.join(w, 'a')); await save(w, 'b', 'model\n');
    });
    assert.equal(r.status, 'partial'); assert.deepEqual(r.files.map(f => f.path), ['b']); s.dispose();
  });
  await test('旧会话缺少基线不回退工作区，继续执行仅展示新记录', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'old', 'preexisting\n');
    s.select('historical', w, true); assert.equal((await s.review()).status, 'missing');
    const r = await turn(s, w, () => save(w, 'new', 'current\n'), 'historical');
    assert.equal(r.status, 'partial'); assert.deepEqual(r.files.map(f => f.path), ['new']); s.dispose();
  });
  await test('中断重载恢复最后一个已保存检查点，不收集检查点之后的工作区修改', async () => {
    const { workspace: w, storage, sessions: s } = await fixture(); await save(w, 'file', 'before\n');
    await s.beginTurn('s1', w); await save(w, 'file', 'checkpoint one\n'); await s.checkpoint('s1', w);
    await save(w, 'file', 'checkpoint two\n'); await s.checkpoint('s1', w);
    s.dispose(); await save(w, 'file', 'unrecorded outside\n');
    const restored = new SessionChanges(storage); restored.select('s1', w, true);
    const r = await restored.review(); assert.equal(r.status, 'partial');
    assert.deepEqual(await contents(r), ['before\n', 'checkpoint two\n']);
    const next = await turn(restored, w, () => save(w, 'new', 'next turn\n'));
    assert.deepEqual(next.files.map(file => file.path), ['file', 'new']);
    assert.deepEqual(await contents(next, next.files.find(file => file.path === 'file')), ['before\n', 'checkpoint two\n']);
    restored.dispose();
  });
  await test('多次中间检查点不重复合入，最终改回基线后重载仍无差异', async () => {
    const { workspace: w, storage, sessions: s } = await fixture(); await save(w, 'file', 'before\n');
    await s.beginTurn('s1', w); await save(w, 'file', 'first\n'); await s.checkpoint('s1', w);
    await save(w, 'file', 'second\n'); await s.checkpoint('s1', w);
    const preview = await s.review(); assert.deepEqual(await contents(preview), ['before\n', 'second\n']);
    await save(w, 'file', 'before\n'); await s.checkpoint('s1', w, true); s.dispose();
    const restored = new SessionChanges(storage); restored.select('s1', w, true);
    const r = await restored.review(); assert.equal(r.status, 'ready'); assert.equal(r.files.length, 0); restored.dispose();
  });
  await test('未收到结束边界就重载：不把重载后文件当成会话结果', async () => {
    const { workspace: w, storage, sessions: s } = await fixture(); await save(w, 'file', 'before\n');
    await s.beginTurn('s1', w); await save(w, 'file', 'unknown writer\n'); s.dispose();
    const restored = new SessionChanges(storage); restored.select('s1', w, true);
    const r = await restored.review(); assert.equal(r.status, 'error'); assert.equal(r.files.length, 0); restored.dispose();
  });
  await test('同工作区重叠执行的会话不互相认领更改', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'file', 'before\n');
    await s.beginTurn('s1', w); s.observe({ type: 'model.streaming', sessionId: 's1' }); s.select('s2', w); await s.beginTurn('s2', w); await save(w, 'file', 'ambiguous\n');
    await s.checkpoint('s1', w, true); await s.checkpoint('s2', w, true);
    assert.equal((await s.review()).status, 'error'); s.select('s1', w, true);
    assert.equal((await s.review()).status, 'error'); assert.equal((await s.review()).files.length, 0); s.dispose();
  });
  await test('新建/删除/重命名/二进制基于会话快照统计', async () => {
    const { workspace: w, sessions: s } = await fixture();
    await save(w, 'old', 'rename\n'); await save(w, 'deleted', 'remove\n');
    const r = await turn(s, w, async () => {
      await fs.rename(path.join(w, 'old'), path.join(w, 'renamed')); await fs.unlink(path.join(w, 'deleted'));
      await save(w, 'new', 'one\ntwo'); await save(w, 'binary', Buffer.from([0, 1]));
    });
    assert.equal(r.files.length, 4);
    const renamed = r.files.find(f => f.path === 'renamed'); assert.deepEqual(await contents(r, renamed), ['rename\n', 'rename\n']);
    const binary = r.files.find(f => f.path === 'binary'); assert.ok(binary.binary && binary.added === 0 && binary.deleted === 0);
    assert.equal(r.files.find(f => f.path === 'new').added, 2); assert.equal(r.files.find(f => f.path === 'deleted').deleted, 1); s.dispose();
  });
  await test('中文/空格/引号/制表换行文件名与原型属性名不会破坏路径归属', async () => {
    const { workspace: w, sessions: s } = await fixture();
    const names = ['中文 空格"\t\n.txt', '__proto__', 'constructor'];
    for (const name of names) await save(w, name, 'before\n');
    const r = await turn(s, w, async () => { for (const name of names) await save(w, name, 'after\n'); });
    assert.equal(r.files.length, names.length);
    for (const file of r.files) assert.deepEqual(await contents(r, file), ['before\n', 'after\n']); s.dispose();
  });
  await test('保护目录/gitignore/子目录边界排除；不修改项目索引、引用或对象', async () => {
    const { workspace: w, sessions: s, storage } = await fixture();
    await fs.mkdir(path.join(w, 'sub')); await save(w, 'sub/file', 'before\n'); await save(w, '.gitignore', 'ignored\n');
    for (const name of ['60-marketing', '70-research', '99-archive']) { await fs.mkdir(path.join(w, 'docs', name), { recursive: true }); await save(w, 'docs/' + name + '/file', 'protected\n'); }
    commit(w); const index = await fs.readFile(path.join(w, '.git/index')), head = git(w, 'rev-parse', 'HEAD');
    const objects = git(w, 'count-objects', '-v');
    await turn(s, w, async () => { await save(w, 'sub/file', 'after\n'); await save(w, 'ignored', 'ignored\n'); await save(w, 'docs/99-archive/file', 'still excluded\n'); });
    assert.deepEqual((await s.review()).files.map(f => f.path), ['sub/file']);
    assert.deepEqual(await fs.readFile(path.join(w, '.git/index')), index); assert.equal(git(w, 'rev-parse', 'HEAD'), head); assert.equal(git(w, 'count-objects', '-v'), objects);
    s.select('sub', path.join(w, 'sub')); const r = await turn(s, path.join(w, 'sub'), () => save(w, 'sub/file', 'sub session\n'), 'sub');
    assert.deepEqual(r.files.map(f => f.path), ['file']); assert.ok((await fs.stat(storage)).mode & 0o700); s.dispose();
  });
  await test('拒绝发送后撤销基线，不收集随后的外部编辑；非 Git 工作区明确不可用', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'file', 'before\n');
    await s.beginTurn('s1', w); await s.cancelTurn('s1', w); await save(w, 'file', 'outside\n'); await s.checkpoint('s1', w, true);
    assert.equal((await s.review()).files.length, 0);
    const nonGit = path.join(temp, 'non-git'); await fs.mkdir(nonGit); s.select('no-git', nonGit); await s.beginTurn('no-git', nonGit);
    assert.equal((await s.review()).status, 'error'); s.dispose();
  });
  await test('丢失结束边界后重新发送，不把两轮之间的未知修改延长计入', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'file', 'before\n');
    await s.beginTurn('s1', w); await save(w, 'file', 'unknown gap\n'); await s.checkpoint('s1', w);
    const r = await turn(s, w, async () => {
      assert.equal((await s.review()).status, 'error'); await save(w, 'file', 'new recorded turn\n');
    });
    assert.equal(r.status, 'partial'); assert.deepEqual(await contents(r), ['unknown gap\n', 'new recorded turn\n']); s.dispose();
  });
  await test('未经过插件发送边界的模型执行不冒充完整会话记录', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'file', 'before\n');
    await turn(s, w, () => save(w, 'file', 'recorded\n'));
    s.observe({ type: 'model.streaming', sessionId: 's1' }); await save(w, 'file', 'external execution\n');
    const r = await s.review(); assert.equal(r.status, 'partial');
    assert.deepEqual(await contents(r), ['before\n', 'recorded\n']); s.dispose();
  });
  await test('切换时旧请求仍在准备但未执行，不误判新会话并发或污染基线', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'file', 'before\n');
    await s.beginTurn('s1', w); s.select('s2', w); await s.beginTurn('s2', w);
    await s.cancelTurn('s1'); await save(w, 'file', 'session B\n');
    s.observe({ type: 'model.streaming', sessionId: 's2' }); await s.checkpoint('s2', w, true);
    const r = await s.review(); assert.equal(r.status, 'ready');
    assert.deepEqual(await contents(r), ['before\n', 'session B\n']); s.dispose();
  });
  await test('基线捕获完成前的用户保存也不会混入模型改动', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'a', 'before\n'); await save(w, 'b', 'before\n');
    await turn(s, w, async () => {});
    const store = [...s.stores.values()][0], capture = store.capture.bind(store);
    let announce, release;
    const captured = new Promise(resolve => { announce = resolve; }), gate = new Promise(resolve => { release = resolve; });
    store.capture = async directory => { const tree = await capture(directory); announce(); await gate; return tree; };
    const beginning = s.beginTurn('s1', w); await captured;
    await save(w, 'a', 'user before send\n'); s.externalSave(path.join(w, 'a')); release(); await beginning;
    store.capture = capture; await save(w, 'b', 'model\n'); await s.checkpoint('s1', w, true);
    const r = await s.review(); assert.equal(r.status, 'partial'); assert.deepEqual(r.files.map(f => f.path), ['b']); s.dispose();
  });
  await test('中间检查点失败不污染成功的最终记录', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'file', 'before\n');
    await s.beginTurn('s1', w); await save(w, 'file', 'after\n');
    const store = [...s.stores.values()][0], capture = store.capture.bind(store);
    store.capture = async () => { throw new Error('capture interrupted'); };
    await s.checkpoint('s1', w); assert.equal((await s.review()).status, 'error');
    store.capture = capture; await s.checkpoint('s1', w, true);
    const r = await s.review(); assert.equal(r.status, 'ready');
    assert.deepEqual(await contents(r), ['before\n', 'after\n']); s.dispose();
  });
  await test('专用 diff 两侧均为当前会话持久只读资源，侧栏关闭/重新注册后仍能读取', async () => {
    const { workspace: w, storage, sessions: s } = await fixture(); await save(w, 'a', 'before\n'); await save(w, 'b', 'before\n');
    await turn(s, w, async () => { await save(w, 'a', 'session\n'); await save(w, 'b', 'session\n'); });
    await save(w, 'a', 'external\n'); const published = [], review = new ChangeReview(s, 'zh-CN', data => published.push(data));
    let documents = new SnapshotDocuments(storage);
    try {
      await review.review(); const [command, title, files] = testState.commands.at(-1), [, before, after] = files[0];
      assert.equal(command, 'vscode.changes'); assert.ok(title.includes('ZCode')); assert.equal(files.length, 2);
      assert.equal(before.scheme, 'zcode-snapshot'); assert.equal(after.scheme, 'zcode-snapshot'); assert.equal(testState.options.isReadonly, true);
      assert.equal(Buffer.from(await documents.readFile(before)).toString(), 'before\n');
      assert.equal(Buffer.from(await documents.readFile(after)).toString(), 'session\n');
      assert.equal((await documents.stat(after)).size, Buffer.byteLength('session\n'));
      assert.throws(() => documents.writeFile(after, new Uint8Array()), error => error.code === 'NoPermissions');
      review.dispose();
      assert.equal(Buffer.from(await documents.readFile(after)).toString(), 'session\n');
      documents.dispose(); documents = new SnapshotDocuments(storage);
      assert.equal(Buffer.from(await documents.readFile(before)).toString(), 'before\n');
      assert.equal(published.at(-1).sessionId, 's1'); const count = testState.commands.length;
      const next = new ChangeReview(s, 'zh-CN', () => {}); s.select('missing', w, true);
      await next.review(); assert.equal(testState.commands.length, count); next.dispose();
    } finally { review.dispose(); documents.dispose(); s.dispose(); }
    assert.equal(testState.provider, null);
  });
  await test('快照资源保留二进制原始字节，缺失/非法资源显式报错且不可写', async () => {
    const { workspace: w, storage, sessions: s } = await fixture(); await save(w, 'data.bin', Buffer.from([0, 1]));
    await turn(s, w, () => save(w, 'data.bin', Buffer.from([0, 2, 3])));
    const documents = new SnapshotDocuments(storage), view = new ChangeReview(s, 'zh-CN', () => {});
    try {
      await view.review(); const [, , resources] = testState.commands.at(-1), [, before, after] = resources[0];
      assert.deepEqual(Buffer.from(await documents.readFile(before)), Buffer.from([0, 1]));
      assert.deepEqual(Buffer.from(await documents.readFile(after)), Buffer.from([0, 2, 3]));
      await assert.rejects(documents.readFile({ ...after, query: 'workspace=../outside&blob=' + '0'.repeat(40) }), error => error.code === 'FileNotFound');
      await assert.rejects(documents.readFile({ ...after, query: after.query.replace(/blob=[^&]+/, 'blob=' + '0'.repeat(40)) }), error => error.code === 'FileNotFound');
      assert.throws(() => documents.delete(after), error => error.code === 'NoPermissions');
    } finally { view.dispose(); documents.dispose(); s.dispose(); }
  });
  await test('点击查看变更直接打开专用多文件 diff，包含所有会话文件', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'a.ts', 'before a\n'); await save(w, 'b.ts', 'before b\n');
    await turn(s, w, async () => { await save(w, 'a.ts', 'after a\n'); await save(w, 'b.ts', 'after b\n'); });
    const review = new ChangeReview(s, 'zh-CN', () => {});
    try {
      await review.review(); const [command, title, files] = testState.commands.at(-1);
      assert.equal(command, 'vscode.changes'); assert.ok(title.includes('ZCode')); assert.equal(files.length, 2);
    } finally { review.dispose(); s.dispose(); }
  });
  await test('真实发送和队列出队均等待各自基线，切换会话不会发到错误会话', async () => {
    const order = [], gates = []; let sid = 0;
    const server = { dispose() {}, async request(method) {
      if (method === 'session/create') return { session: { sessionId: 's' + ++sid, mode: 'build' }, settings: {}, projection: {}, messages: [], runtime: {} };
      if (method === 'session/send') { order.push('rpc-send'); return {}; }
      return { events: [], sessions: [] };
    } };
    const rejected = [], ctl = new SessionController(server, { toWebview() {}, onBeforeSend: () => new Promise(resolve => { order.push('baseline'); gates.push(resolve); }), onSendRejected: id => rejected.push(id) });
    try {
      await ctl.newSession('/workspace', 'build');
      const first = ctl.send('first'); await new Promise(resolve => setImmediate(resolve));
      await ctl.send('queued'); assert.deepEqual(order, ['baseline']); gates.shift()(); await first;
      ctl.handleNotification('session/event', { type: 'turn.completed', sessionId: 's1', payload: {} });
      const queued = ctl.drainQueue(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, ['baseline', 'rpc-send', 'baseline']); gates.shift()(); await queued;
      ctl.handleNotification('session/event', { type: 'turn.completed', sessionId: 's1', payload: {} });
      const stale = ctl.send('stale'); await new Promise(resolve => setImmediate(resolve)); await ctl.newSession('/workspace', 'build');
      gates.shift()(); await stale; assert.equal(order.filter(x => x === 'rpc-send').length, 2); assert.deepEqual(rejected, ['s1']);
    } finally { ctl.dispose(); }
  });
  await test('切换后旧会话结束仍保存对应记录，即使没有 webview', async () => {
    const { workspace: w, sessions: s } = await fixture(); await save(w, 'file', 'before\n');
    const provider = new ChatViewProvider({ locale: 'zh-CN', sessionChanges: s, workspacePath: () => w });
    provider.post({ kind: 'session-snapshot', data: { session: { sessionId: 's1' }, messages: [] } });
    await s.beginTurn('s1', w); await save(w, 'file', 'after\n');
    const server = { dispose() {}, async request() { return { events: [], sessions: [] }; } };
    const ctl = new SessionController(server, { toWebview: msg => provider.post(msg), onSessionEvent: event => s.observe(event) });
    ctl.currentSessionId = 's2';
    provider.post({ kind: 'session-snapshot', data: { session: { sessionId: 's2' }, messages: [] } });
    ctl.handleNotification('session/event', { type: 'turn.completed', sessionId: 's1', payload: {} });
    s.select('s1', w, true);
    assert.deepEqual(await contents(await s.review()), ['before\n', 'after\n']); ctl.dispose(); s.dispose();
  });
} finally { await fs.rm(temp, { recursive: true, force: true }); }
