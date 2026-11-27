const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { test } = require('node:test');
const { findGitRoot, GitRepository } = require('../out/git');

function createRepo(context) {
  const root = mkdtempSync(join(tmpdir(), 'git-diff-test-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--template=', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  function write(path, contents) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  function commit(subject) {
    git('add', '--all');
    git('commit', '--quiet', '-m', subject);
    return git('rev-parse', 'HEAD');
  }
  return { root, repo: new GitRepository(root, 'git'), git, write, commit };
}

test('file and line history follow renames, including quoted paths and the root commit', async context => {
  const { root, repo, git, write, commit } = createRepo(context);
  const before = 'old name#%.txt';
  const after = process.platform === 'win32' ? '目录/新 名.txt' : '目录/新\t名.txt';
  write(before, 'zero\nfirst\nsecond\nthird\n');
  const first = commit('initial');
  write(before, 'prefix\nzero\nFIRST\nsecond\nthird\n');
  const edited = commit('edit one line');
  mkdirSync(join(root, '目录'));
  git('mv', before, after);
  assert.equal(await repo.historyPath(edited, after), before);
  const renamed = commit('rename file');
  write(after, 'prefix\nzero\nFIRST\nSECOND\nthird\n');
  const head = commit('edit another line');

  assert.equal(await findGitRoot('git', join(root, '目录')), realpathSync(root));
  assert.deepEqual((await repo.fileHistory(head, after, 2)).map(entry => entry.commit.id), [head, renamed]);
  const file = await repo.fileHistory(head, after, 20);
  assert.deepEqual(file.map(entry => entry.commit.id), [head, renamed, edited, first]);
  assert.deepEqual(file[1].change, { status: 'R', before, after });
  assert.equal(file[3].change.before, undefined);
  assert.equal(file[3].commit.parent, undefined);
  const line = await repo.lineHistory(head, after, [{ start: 3, end: 3 }], 20);
  assert.deepEqual(line.map(entry => entry.commit.id), [edited, first]);
  assert.equal(line[0].change.after, before);
  assert.equal(line[0].line, 3);
  const renamedLine = await repo.lineHistory(head, after, [{ start: 4, end: 4 }], 20);
  assert.equal(renamedLine[0].change.after, after);
  assert.equal(await repo.snapshot(first, before), 'zero\nfirst\nsecond\nthird\n');
});

test('dirty line mapping excludes inserted and deleted lines and tolerates CRLF', async context => {
  const { repo, write, commit } = createRepo(context);
  write('source.txt', 'a\nb\nc\nd\ne\nf\n');
  const head = commit('initial');
  const working = 'new\r\na\r\nb\r\nd\r\nE\r\nf\r\n';
  const map = await repo.lineMapper(head, 'source.txt', working);
  assert.deepEqual(map({ start: 1, end: 1 }), []);
  const ranges = map({ start: 1, end: 6 });
  assert.deepEqual(ranges, [{ start: 1, end: 2 }, { start: 4, end: 6 }]);
  assert.equal((await repo.lineHistory(head, 'source.txt', ranges, 10))[0].commit.id, head);
  const missing = await repo.lineMapper(head, 'missing.txt', working);
  assert.deepEqual(missing({ start: 1, end: 1 }), []);
  assert.deepEqual(map({ start: 7, end: 7 }), []);
});

test('tip-to-tip comparison keeps direction, handles remote refs and reads fixed snapshots', async context => {
  const { repo, git, write, commit } = createRepo(context);
  write('renamed.txt', 'a\nb\nc\n');
  write('diverged.txt', 'common\n');
  const common = commit('common');
  git('branch', 'topic');
  write('diverged.txt', 'main-only\n');
  write('left.txt', 'main\n');
  const base = commit('main commit');
  git('switch', '--quiet', 'topic');
  git('mv', 'renamed.txt', 'moved.txt');
  write('right.txt', 'topic\n');
  write('binary.dat', Buffer.from([0, 1, 2]));
  const target = commit('topic commit');
  git('update-ref', 'refs/remotes/origin/topic', target);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/topic');

  assert.deepEqual((await repo.branches()).map(branch => [branch.name, branch.current, branch.remote]), [
    ['topic', true, false], ['main', false, false], ['origin/topic', false, true],
  ]);
  assert.equal(await repo.resolveCommit(target.slice(0, 8)), target);
  assert.equal(await repo.resolveCommit('refs/heads/main'), base);
  assert.equal(await repo.resolveCommit('ffffffffffffffffffffffffffffffffffffffff'), undefined);
  assert.deepEqual(new Set((await repo.recentCommits(target)).map(item => item.id)), new Set([target, base, common]));
  assert.deepEqual(await repo.compare(base, target), [
    { status: 'A', before: undefined, after: 'binary.dat' },
    { status: 'M', before: 'diverged.txt', after: 'diverged.txt' },
    { status: 'D', before: 'left.txt', after: undefined },
    { status: 'R', before: 'renamed.txt', after: 'moved.txt' },
    { status: 'A', before: undefined, after: 'right.txt' },
  ]);
  assert.deepEqual(await repo.compare(target, target), []);
  assert.equal(await repo.snapshot(base, 'diverged.txt'), 'main-only\n');
  assert.match(await repo.snapshot(target, 'binary.dat'), /3 字节\nSHA-256 [a-f0-9]{64}/);
});

test('refresh resolves the selected branch refs while preserving independent and fixed comparisons', async context => {
  const { repo, git, write, commit } = createRepo(context);
  write('base.txt', 'base\n');
  const initial = commit('initial');
  git('branch', 'origin/topic');
  git('update-ref', 'refs/remotes/origin/topic', initial);
  const main = { label: 'main', id: initial, ref: 'refs/heads/main' };
  const local = { label: 'origin/topic', id: initial, ref: 'refs/heads/origin/topic' };
  const remote = { label: 'origin/topic', id: initial, ref: 'refs/remotes/origin/topic' };
  const fixed = { label: initial.slice(0, 8), id: initial };
  assert.deepEqual((await repo.compareRevisions(main, remote)).changes, []);

  write('new.txt', 'committed change\n');
  const updated = commit('branch update');
  git('update-ref', remote.ref, updated);
  git('update-ref', main.ref, initial);
  write('working.txt', 'uncommitted change\n');

  const refreshed = await repo.compareRevisions(main, remote);
  assert.equal(refreshed.target.id, updated);
  assert.deepEqual(refreshed.changes.map(change => change.after), ['new.txt']);
  assert.deepEqual((await repo.compareRevisions(main, local)).changes, []);
  assert.deepEqual((await repo.compareRevisions(fixed, fixed)).changes, []);

  git('update-ref', '-d', remote.ref);
  await assert.rejects(repo.compareRevisions(main, remote), /refs\/remotes\/origin\/topic/);
  assert.equal(await repo.snapshot(refreshed.target.id, 'new.txt'), 'committed change\n');
});
