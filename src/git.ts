import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Commit {
  id: string;
  parent?: string;
  author: string;
  date: string;
  subject: string;
}

export interface Change {
  status: string;
  before?: string;
  after?: string;
}

export interface HistoryEntry {
  commit: Commit;
  change: Change;
  line?: number;
}

export interface Branch {
  name: string;
  id: string;
  remote: boolean;
  current: boolean;
}

export interface LineRange {
  start: number;
  end: number;
}

export type LineMapper = (selection: LineRange) => LineRange[];

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

const commitFields = '%H%x00%P%x00%an%x00%aI%x00%s';
const changeFlags = ['--no-ext-diff', '--no-textconv', '--no-relative', '--find-renames'];

function runGit(
  executable: string,
  cwd: string,
  args: string[],
  allowedExitCodes: number[] = [],
  signal?: AbortSignal,
): Promise<{ output: Buffer; code: number; stderr: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(executable, ['--no-pager', '--literal-pathspecs', ...args], {
      cwd,
      encoding: 'buffer',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 32 * 1024 * 1024,
      signal,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ output: stdout, code: 0, stderr: '' });
      } else if (typeof error.code === 'number' && allowedExitCodes.includes(error.code)) {
        resolve({ output: stdout, code: error.code, stderr: stderr.toString('utf8').trim() });
      } else {
        const message = error.code === 'ENOENT'
          ? '找不到 Git，请安装 Git 或检查 VS Code 的 git.path 设置。'
          : stderr.toString('utf8').trim() || error.message;
        reject(new Error(message));
      }
    });
  });
}

export async function findGitRoot(executable: string, directory: string, signal?: AbortSignal): Promise<string | undefined> {
  const { output, code, stderr } = await runGit(executable, directory, ['rev-parse', '--show-toplevel'], [128], signal);
  if (code === 0) {
    return output.toString('utf8').replace(/\r?\n$/, '');
  }
  if (!/not a git repository|must be run in a work tree/i.test(stderr)) {
    throw new Error(stderr || 'Git 无法读取仓库根目录。');
  }
}

function readCommit(fields: string[], index: number): Commit {
  const [id, parents, author, date, subject] = fields.slice(index, index + 5);
  return { id, parent: parents.split(' ')[0] || undefined, author, date, subject };
}

function readChanges(fields: string[], start: number): { changes: Change[]; next: number } {
  const changes: Change[] = [];
  let index = start;
  while (fields[index]) {
    const status = fields[index++].trim()[0];
    const path = fields[index++];
    if (status === 'R' || status === 'C') {
      changes.push({ status, before: path, after: fields[index++] });
    } else {
      changes.push({ status, before: status === 'A' ? undefined : path, after: status === 'D' ? undefined : path });
    }
  }
  return { changes, next: index };
}

function readHunks(patch: string): Hunk[] {
  return Array.from(patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm), match => ({
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  }));
}

function patchPath(header: string | undefined): string | undefined {
  const raw = header?.slice(4).split('\t', 1)[0];
  if (!raw || raw === '/dev/null') {
    return undefined;
  }
  if (!raw.startsWith('"')) {
    return raw.slice(2);
  }
  // Git quotes tabs, newlines and non-ASCII path bytes using C-style escapes.
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const bytes = raw.slice(1, -1).match(/\\(?:[0-7]{3}|.)|[^\\]/gs)?.map(character => {
    if (character.length === 4) {
      return parseInt(character.slice(1), 8);
    }
    return character.length === 2 ? escapes[character[1]] : character.charCodeAt(0);
  }) ?? [];
  return Buffer.from(bytes).toString('utf8').slice(2);
}

function mapRanges(selection: LineRange, hunks: Hunk[]): LineRange[] {
  const ranges: LineRange[] = [];
  const append = (start: number, end: number) => {
    if (start <= end) {
      const previous = ranges.at(-1);
      if (previous && previous.end + 1 === start) {
        previous.end = end;
      } else {
        ranges.push({ start, end });
      }
    }
  };

  let cursor = selection.start;
  let offset = 0;
  for (const hunk of hunks) {
    const first = hunk.newStart + (hunk.newCount === 0 ? 1 : 0);
    if (first > selection.end) {
      break;
    }
    append(cursor + offset, Math.min(first - 1, selection.end) + offset);

    const next = first + hunk.newCount;
    if (hunk.oldCount === hunk.newCount) {
      append(Math.max(cursor, first) + offset, Math.min(next - 1, selection.end) + offset);
    }
    cursor = Math.max(cursor, next);
    offset += hunk.oldCount - hunk.newCount;
  }
  append(cursor + offset, selection.end + offset);
  return ranges;
}

function createLineMapper(lineCount: number, hunks: Hunk[] = []): LineMapper {
  return selection => mapRanges({ start: selection.start, end: Math.min(selection.end, lineCount) }, hunks);
}

function decodeBlob(blob: Buffer): string | undefined {
  const bom = blob.subarray(0, 2).toString('hex');
  if (bom === 'fffe' || bom === 'feff') {
    return new TextDecoder(bom === 'fffe' ? 'utf-16le' : 'utf-16be').decode(blob);
  }
  if (blob.subarray(0, 8000).includes(0)) {
    return undefined;
  }
  return new TextDecoder().decode(blob);
}

export class GitRepository {
  constructor(readonly root: string, private readonly executable: string) {}

  private async text(args: string[], signal?: AbortSignal): Promise<string> {
    const result = await runGit(this.executable, this.root, args, [], signal);
    return result.output.toString('utf8');
  }

  async resolveCommit(ref: string, signal?: AbortSignal): Promise<string | undefined> {
    const { output, code } = await runGit(this.executable, this.root, [
      'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`,
    ], [128], signal);
    return code === 0 ? output.toString('utf8').trim() : undefined;
  }

  async branches(): Promise<Branch[]> {
    const output = await this.text([
      'for-each-ref', '--format=%(HEAD)%00%(refname)%00%(objectname)%00%(symref)',
      'refs/heads', 'refs/remotes',
    ]);
    const branches: Branch[] = [];
    for (const row of output.trimEnd().split('\n')) {
      if (!row) {
        continue;
      }
      const [head, ref, id, target] = row.split('\0');
      if (!target) {
        branches.push({ name: ref.split('/').slice(2).join('/'), id, remote: ref.startsWith('refs/remotes/'), current: head === '*' });
      }
    }
    return branches.sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote));
  }

  async recentCommits(head: string | undefined): Promise<Commit[]> {
    const output = await this.text([
      'log', '--no-show-signature', '--no-notes', '--no-decorate', '--no-patch', '-z',
      '-n', '80', `--format=tformat:${commitFields}`, '--all', ...(head ? [head] : []), '--',
    ]);
    const fields = output.split('\0');
    const commits: Commit[] = [];
    for (let i = 0; fields[i]; i += 5) {
      commits.push(readCommit(fields, i));
    }
    return commits;
  }

  async compare(base: string, target: string): Promise<Change[]> {
    const output = await this.text(['diff', ...changeFlags, '--name-status', '-z', base, target, '--']);
    return readChanges(output.split('\0'), 0).changes;
  }

  async historyPath(head: string, path: string, signal?: AbortSignal): Promise<string> {
    const tree = await this.text(['ls-tree', '-z', head, '--', path], signal);
    if (tree) {
      return path;
    }
    const staged = await this.text(['diff', '--cached', ...changeFlags, '--name-status', '-z', head, '--'], signal);
    return readChanges(staged.split('\0'), 0).changes.find(change => change.status === 'R' && change.after === path)?.before ?? path;
  }

  async fileHistory(head: string, path: string, limit: number, signal?: AbortSignal): Promise<HistoryEntry[]> {
    const output = await this.text([
      'log', '--no-show-signature', '--no-notes', '--no-decorate', '--follow', ...changeFlags,
      `--max-count=${limit}`, `--format=tformat:%x00${commitFields}`, '--name-status', '-z', head, '--', path,
    ], signal);
    const fields = output.split('\0');
    const entries: HistoryEntry[] = [];
    let trackedPath = path;
    let index = 0;
    while (index < fields.length) {
      if (!fields[index]) {
        index++;
        continue;
      }
      const commit = readCommit(fields, index);
      const { changes, next } = readChanges(fields, index + 5);
      const change = changes.find(item => (item.after ?? item.before) === trackedPath);
      if (change) {
        entries.push({ commit, change });
        trackedPath = change.before ?? trackedPath;
      }
      index = next;
    }
    return entries;
  }

  async lineHistory(head: string, path: string, ranges: LineRange[], limit: number, signal?: AbortSignal): Promise<HistoryEntry[]> {
    const output = await this.text([
      '-c', 'core.quotePath=true', 'log', '--no-show-signature', '--no-notes', '--no-decorate',
      '--no-color', '--src-prefix=a/', '--dst-prefix=b/', ...changeFlags, `--max-count=${limit}`,
      `--format=format:%x00${commitFields}%x00`,
      ...ranges.flatMap(range => ['-L', `${range.start},${range.end}:${path}`]), head,
    ], signal);
    const fields = output.split('\0');
    const entries: HistoryEntry[] = [];
    for (let index = 1; fields[index]; index += 6) {
      const patch = fields[index + 5];
      const line = readHunks(patch).find(hunk => hunk.newCount > 0)?.newStart;
      const headers = patch.split('\n');
      const before = patchPath(headers.find(row => row.startsWith('--- ')));
      const after = patchPath(headers.find(row => row.startsWith('+++ ')));
      if (before || after) {
        entries.push({ commit: readCommit(fields, index), change: { status: before ? (after ? 'M' : 'D') : 'A', before, after }, line });
      }
    }
    return entries;
  }

  async lineMapper(head: string, path: string, current: string, signal?: AbortSignal): Promise<LineMapper> {
    const { output, code } = await runGit(this.executable, this.root, ['cat-file', 'blob', `${head}:${path}`], [128], signal);
    if (code !== 0) {
      return createLineMapper(0);
    }
    if (output.includes(0)) {
      throw new Error('Git 无法对二进制文件或 UTF-16 文本追踪行历史。');
    }
    const baseline = new TextDecoder().decode(output).replace(/\r\n/g, '\n');
    const working = current.replace(/\r\n/g, '\n');
    const lineCount = working ? working.split('\n').length - Number(working.endsWith('\n')) : 0;
    if (!lineCount || baseline === working) {
      return createLineMapper(lineCount);
    }

    const scratch = await mkdtemp(join(tmpdir(), 'git-diff-lines-'));
    try {
      const oldFile = join(scratch, 'committed');
      const newFile = join(scratch, 'current');
      await Promise.all([writeFile(oldFile, baseline), writeFile(newFile, working)]);
      const { output: patch } = await runGit(this.executable, scratch, [
        'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--text',
        '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=0', '--', oldFile, newFile,
      ], [1], signal);
      return createLineMapper(lineCount, readHunks(patch.toString('utf8')));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async snapshot(commit: string, path: string): Promise<string> {
    const { output, code } = await runGit(this.executable, this.root, ['cat-file', 'blob', `${commit}:${path}`], [128]);
    if (code === 0) {
      return decodeBlob(output) ?? `二进制文件 · ${output.length} 字节\nSHA-256 ${createHash('sha256').update(output).digest('hex')}\n`;
    }
    const entry = await this.text(['ls-tree', '-z', commit, '--', path]);
    const submodule = /^160000 commit ([a-f\d]+)\t/.exec(entry);
    if (submodule) {
      return `Subproject commit ${submodule[1]}\n`;
    }
    throw new Error(`无法读取 ${commit.slice(0, 8)} 中的 ${path}。`);
  }
}
