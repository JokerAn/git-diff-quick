import * as vscode from 'vscode';
import { Change, Commit, GitRepository, Revision } from './git';
import { fileUri, snapshotUri } from './workspace';

export interface Comparison {
  repo: GitRepository;
  base: Revision;
  target: Revision;
  changes: Change[];
}

export const shortId = (id: string) => id.slice(0, 8);

export function commitDate(commit: Commit): string {
  return commit.date.slice(0, 10);
}

export function comparisonTitle(comparison: Comparison): string {
  return `${comparison.base.label} → ${comparison.target.label}`;
}

export async function chooseBranches(repo: GitRepository): Promise<[Revision, Revision] | undefined> {
  const branches = await repo.branches();
  if (!branches.length) {
    throw new Error('当前仓库还没有可比较的分支。');
  }
  const items = branches.map(branch => ({
    label: branch.name,
    id: branch.id,
    ref: `${branch.remote ? 'refs/remotes' : 'refs/heads'}/${branch.name}`,
    description: [branch.current ? '当前分支' : branch.remote ? '远程分支' : '本地分支', shortId(branch.id)].join(' · '),
  }));
  const base = await vscode.window.showQuickPick(items, { title: '比较分支（1/2）', placeHolder: '选择左侧基准分支' });
  if (!base) {
    return;
  }
  const target = await vscode.window.showQuickPick(items, { title: '比较分支（2/2）', placeHolder: `选择右侧目标分支 · 基准 ${base.label}` });
  return target ? [base, target] : undefined;
}

interface CommitPick extends vscode.QuickPickItem {
  id: string;
  typed?: boolean;
}

function pickCommit(items: CommitPick[], title: string, placeHolder: string): Promise<CommitPick | undefined> {
  const picker = vscode.window.createQuickPick<CommitPick>();
  picker.title = title;
  picker.placeholder = placeHolder;
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.items = items;

  return new Promise(resolve => {
    const onInput = picker.onDidChangeValue(value => {
      const id = value.trim().toLowerCase();
      if (/^[a-f\d]{4,64}$/.test(id)) {
        const typed = { label: `使用提交 ID ${id}`, id, typed: true, alwaysShow: true };
        picker.items = [typed, ...items];
        picker.activeItems = [typed];
      } else {
        picker.items = items;
      }
    });
    const onAccept = picker.onDidAccept(() => {
      const item = picker.selectedItems[0];
      if (item) {
        resolve(item);
        picker.hide();
      }
    });
    const onHide = picker.onDidHide(() => {
      resolve(undefined);
      onInput.dispose();
      onAccept.dispose();
      onHide.dispose();
      picker.dispose();
    });
    picker.show();
  });
}

export async function chooseCommits(repo: GitRepository): Promise<[Revision, Revision] | undefined> {
  const commits = await repo.recentCommits(await repo.resolveCommit('HEAD'));
  const items: CommitPick[] = commits.map(commit => ({
    id: commit.id,
    label: commit.subject || '（无提交说明）',
    description: shortId(commit.id),
    detail: `${commit.author} · ${commitDate(commit)}`,
  }));
  const choose = async (title: string, prompt: string): Promise<Revision | undefined> => {
    const item = await pickCommit(items, title, prompt);
    if (!item) {
      return;
    }
    const id = item.typed ? await repo.resolveCommit(item.id) : item.id;
    if (!id) {
      throw new Error(`无法解析提交 ${item.id}。请使用完整 SHA 或唯一的短 SHA。`);
    }
    return { id, label: shortId(id) };
  };
  const base = await choose('比较提交（1/2）', '输入提交 ID，或选择左侧基准提交');
  if (!base) {
    return;
  }
  const target = await choose('比较提交（2/2）', `输入提交 ID，或选择右侧目标提交 · 基准 ${base.label}`);
  return target ? [base, target] : undefined;
}

export async function openAllChanges(comparison: Comparison, title: string): Promise<void> {
  const { repo, base, target, changes } = comparison;
  const resources = changes.map(change => [
    fileUri(repo, (change.after ?? change.before)!),
    change.before ? snapshotUri(repo, change.before, base.id) : undefined,
    change.after ? snapshotUri(repo, change.after, target.id) : undefined,
  ]);
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}

export async function openFileDiff(repo: GitRepository, change: Change, left: Partial<Revision>, right: Partial<Revision>, line?: number) {
  const before = (change.before ?? change.after)!;
  const after = (change.after ?? change.before)!;
  const label = `${after} · ${left.label ?? '空文件'} → ${right.label ?? '空文件'}`;
  const options: vscode.TextDocumentShowOptions = { preview: true };
  if (line && change.after) {
    options.selection = new vscode.Range(line - 1, 0, line - 1, 0);
  }
  await vscode.commands.executeCommand('vscode.diff',
    snapshotUri(repo, before, change.before ? left.id : undefined),
    snapshotUri(repo, after, change.after ? right.id : undefined),
    label, options,
  );
}
