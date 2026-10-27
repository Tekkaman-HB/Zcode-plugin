/**
 * [INPUT]: node:child_process/fs/path/crypto；项目 Git 只用于列出受版本管理约束的路径
 * [OUTPUT]: SnapshotStore、SnapshotEntry、SnapshotDiff；有界并行扫描元数据，按文件身份/纳秒修改时间复用未变对象，提供私有 Git 对象库捕获/合并/差异与原始字节读取
 * [POS]: ui 的会话快照数据层，无 vscode；不写项目 Git 索引/分支/对象，不执行过滤器或外部 diff
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SnapshotEntry { hash: string; mode: string }
export interface SnapshotDiff {
  path: string; added: number; deleted: number; binary: boolean;
  before: SnapshotEntry | null; after: SnapshotEntry | null;
}
export type SnapshotFiles = Record<string, SnapshotEntry>;
interface CachedFile { stamp: string; entry: SnapshotEntry }
const MAX_MERGE_BYTES = 8 * 1024 * 1024;
const CAPTURE_BATCH_SIZE = 64;
const CACHE_SETTLE_MS = 2000;
const EXCLUDED = ['docs/60-marketing', 'docs/70-research', 'docs/99-archive'];
const PATHS = ['.', ...EXCLUDED.map(dir => `:(top,exclude)${dir}/**`)];

export function sameEntry(a: SnapshotEntry | null | undefined, b: SnapshotEntry | null | undefined): boolean {
  return a?.hash === b?.hash && a?.mode === b?.mode;
}

async function run(cwd: string, args: string[], input?: string | Buffer, env?: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', ...args], {
      cwd, env: { ...process.env, LC_ALL: 'C', ...env }, stdio: ['pipe', 'pipe', 'pipe']
    });
    const output: Buffer[] = [], errors: Buffer[] = [];
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', data => output.push(data));
    child.stderr.on('data', data => errors.push(data));
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(Buffer.concat(output));
      else reject(Object.assign(new Error('Git snapshot failed'), { code, detail: Buffer.concat(errors).toString() }));
    });
    child.stdin.on('error', () => { /* 子进程提前退出由 close 统一报告。 */ });
    child.stdin.end(input);
  });
}

export class SnapshotStore {
  private capturedFiles = new Map<string, CachedFile>();
  constructor(readonly directory: string) {}
  private env(index?: string): NodeJS.ProcessEnv {
    return {
      GIT_DIR: this.directory, GIT_INDEX_FILE: index ?? path.join(this.directory, 'unused-index'),
      GIT_OBJECT_DIRECTORY: path.join(this.directory, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'
    };
  }
  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { await fs.access(path.join(this.directory, 'HEAD')); }
    catch { await run(this.directory, ['init', '--bare', '--quiet', this.directory], undefined, this.env()); }
  }
  private git(args: string[], input?: string | Buffer, cwd = this.directory, index?: string): Promise<Buffer> {
    return run(cwd, args, input, this.env(index));
  }
  async blob(content: Buffer): Promise<SnapshotEntry> {
    const hash = (await this.git(['hash-object', '--no-filters', '-w', '--stdin'], content)).toString().trim();
    return { hash, mode: '100644' };
  }
  async size(entry: SnapshotEntry): Promise<number> {
    return Number((await this.git(['cat-file', '-s', entry.hash])).toString());
  }
  async content(entry: SnapshotEntry | null): Promise<Buffer> {
    return entry ? this.git(['cat-file', 'blob', entry.hash]) : Buffer.alloc(0);
  }
  async tree(files: SnapshotFiles): Promise<string> {
    const index = path.join(this.directory, 'index-' + randomUUID());
    try {
      await this.git(['read-tree', '--empty'], undefined, this.directory, index);
      const records = Object.entries(files).map(([file, entry]) => `${entry.mode} ${entry.hash}\t${file}\0`).join('');
      if (records) await this.git(['update-index', '-z', '--index-info'], records, this.directory, index);
      return (await this.git(['write-tree'], undefined, this.directory, index)).toString().trim();
    } finally {
      await fs.rm(index, { force: true }); await fs.rm(index + '.lock', { force: true });
    }
  }
  async files(tree: string): Promise<SnapshotFiles> {
    const result: SnapshotFiles = Object.create(null);
    const output = (await this.git(['ls-tree', '-rz', '--full-tree', tree])).toString();
    for (const record of output.split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t'), [mode, type, hash] = record.slice(0, tab).split(' ');
      if (type === 'blob') result[record.slice(tab + 1)] = { hash, mode };
    }
    return result;
  }
  async capture(directory: string): Promise<string> {
    const workspace = await fs.realpath(directory);
    const root = (await run(workspace, ['rev-parse', '--show-toplevel'])).toString().replace(/\n$/, '');
    const listed = (await run(workspace, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...PATHS])).toString();
    const files: SnapshotFiles = Object.create(null), regular: { name: string; mode: string; absolute: string; stamp: string | null }[] = [];
    const captured = new Map<string, CachedFile>();
    const stableBefore = BigInt(Date.now() - CACHE_SETTLE_MS) * 1000000n;
    const candidates = [...new Set(listed.split('\0').filter(Boolean))];
    for (let offset = 0; offset < candidates.length; offset += CAPTURE_BATCH_SIZE) {
      const metadata = await Promise.all(candidates.slice(offset, offset + CAPTURE_BATCH_SIZE).map(async file => {
        // Git 列出的路径先验证再读取：拒绝越界路径与保护目录。
        if (path.isAbsolute(file) || file.split('/').includes('..')) return;
        const absolute = path.resolve(workspace, file);
        if (absolute !== workspace && !absolute.startsWith(workspace + path.sep)) return;
        const relative = path.relative(root, absolute);
        if (EXCLUDED.some(dir => relative === dir || relative.startsWith(dir + '/'))) return;
        try { return { file, absolute, stat: await fs.lstat(absolute, { bigint: true }) }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }));
      // 保留 Git 列表顺序，避免并发完成顺序把后续文件读取打乱。
      for (const entry of metadata) {
        if (!entry) continue;
        const { file, absolute, stat } = entry;
        if (stat.isSymbolicLink()) files[file] = { ...await this.blob(Buffer.from(await fs.readlink(absolute))), mode: '120000' };
        else if (stat.isFile()) {
          // ctime 可识别大小相同且 mtime 被还原的改写，inode/dev 可识别路径被替换。
          const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
          // HFS+ 等秒级时间戳可能吞掉同一时刻的连续改写；近期文件每次重读，不进入缓存。
          const stable = stat.mtimeNs < stableBefore && stat.ctimeNs < stableBefore;
          const cached = this.capturedFiles.get(absolute);
          if (stable && cached?.stamp === stamp) { files[file] = cached.entry; captured.set(absolute, cached); }
          else regular.push({ name: file, mode: stat.mode & 0o111n ? '100755' : '100644', absolute, stamp: stable ? stamp : null });
        }
      }
    }
    if (regular.length) {
      // Git 的 C 风格引号保留中文，转义换行/制表符文件名；不经过 shell。
      const quote = (value: string) => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
      const input = regular.map(file => quote(file.absolute)).join('\n') + '\n';
      const hashes = (await this.git(['hash-object', '--no-filters', '-w', '--stdin-paths'], input, workspace)).toString().trim().split('\n');
      if (hashes.length !== regular.length) throw new Error('Incomplete snapshot');
      regular.forEach((file, i) => {
        const entry = { hash: hashes[i], mode: file.mode };
        files[file.name] = entry;
        if (file.stamp !== null) captured.set(file.absolute, { stamp: file.stamp, entry });
      });
    }
    const tree = await this.tree(files);
    this.capturedFiles = captured;
    return tree;
  }
  async diff(before: SnapshotFiles, after: SnapshotFiles): Promise<SnapshotDiff[]> {
    const base = await this.tree(before), result = await this.tree(after);
    const records = (await this.git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--numstat', '-z', base, result])).toString().split('\0');
    const changes: SnapshotDiff[] = [];
    for (let i = 0; i < records.length && records[i]; i++) {
      const record = records[i], first = record.indexOf('\t'), second = record.indexOf('\t', first + 1);
      const add = record.slice(0, first), del = record.slice(first + 1, second);
      let file = record.slice(second + 1), original = file;
      if (!file) { original = records[++i]; file = records[++i]; }
      changes.push({ path: file, added: Number(add) || 0, deleted: Number(del) || 0,
        binary: add === '-' || del === '-', before: before[original] ?? null, after: after[file] ?? null });
    }
    return changes;
  }
  /** 外部改动与本轮改动冲突时返回 null，不能猜测归属。 */
  async merge(ours: SnapshotEntry, base: SnapshotEntry, theirs: SnapshotEntry): Promise<SnapshotEntry | null> {
    const entries = [ours, base, theirs];
    const sizes = await Promise.all(entries.map(entry => this.git(['cat-file', '-s', entry.hash])));
    if (sizes.some(size => Number(size.toString()) > MAX_MERGE_BYTES)) return null;
    const contents = await Promise.all(entries.map(entry => this.content(entry)));
    if (contents.some(content => content.subarray(0, 8000).includes(0))) return null;
    if (ours.mode !== base.mode && base.mode !== theirs.mode && ours.mode !== theirs.mode) return null;
    const temp = await fs.mkdtemp(path.join(this.directory, 'merge-'));
    try {
      const names = ['ours', 'base', 'theirs'].map(name => path.join(temp, name));
      await Promise.all(names.map((file, i) => fs.writeFile(file, contents[i], { mode: 0o600 })));
      try {
        const content = await this.git(['merge-file', '-p', '--', ...names]);
        return { ...await this.blob(content), mode: base.mode === theirs.mode ? ours.mode : theirs.mode };
      } catch (error) { const code = (error as { code?: number }).code;
        if (code && code > 0 && code < 128) return null; throw error; }
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
}
