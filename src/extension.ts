import { basename } from 'node:path';
import * as vscode from 'vscode';
import { chooseBranches, chooseCommits, Comparison, openFileDiff, shortId } from './comparison';
import { ComparisonView } from './comparisonView';
import { Change, GitRepository, HistoryEntry } from './git';
import { HistoryController } from './history';
import { HistoryItem } from './views';
import { snapshotContent, snapshotScheme, workspaceRepositories } from './workspace';

async function chooseRepository(): Promise<GitRepository | undefined> {
  const repositories = await workspaceRepositories(vscode.window.activeTextEditor?.document.uri);
  if (!repositories.length) {
    throw new Error('请先打开 Git 仓库或仓库中的文件。');
  }
  if (repositories.length === 1) {
    return repositories[0];
  }
  const picked = await vscode.window.showQuickPick(
    repositories.map(repo => ({ label: basename(repo.root), description: repo.root, repo })),
    { title: 'Git Diff', placeHolder: '选择要比较的 Git 仓库', matchOnDescription: true },
  );
  return picked?.repo;
}

export function activate(context: vscode.ExtensionContext) {
  const history = new HistoryController();
  const comparison = new ComparisonView();
  context.subscriptions.push(history, comparison,
    vscode.workspace.registerTextDocumentContentProvider(snapshotScheme, { provideTextDocumentContent: snapshotContent }),
  );

  let comparisonRequest = 0;

  const register = <Args extends unknown[]>(id: string, run: (...args: Args) => void | Thenable<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand(`gitDiff.${id}`, async (...args: Args) => {
      try {
        await run(...args);
      } catch (error) {
        void vscode.window.showErrorMessage(`Git Diff · ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  };

  const compare = async (pick: typeof chooseBranches | typeof chooseCommits) => {
    const request = ++comparisonRequest;
    const repo = await chooseRepository();
    if (!repo || request !== comparisonRequest) {
      return;
    }
    const pair = await pick(repo);
    if (!pair || request !== comparisonRequest) {
      return;
    }
    await comparison.compare(repo, ...pair);
  };

  register('fileHistory', (context?: unknown) => history.browse('file', context));
  register('lineHistory', (context?: unknown) => history.browse('line', context));
  register('moreHistory', history.more.bind(history));
  register('openHistoryEntry', async (repo: GitRepository, entry: HistoryEntry) => {
    const parent = entry.commit.parent;
    await openFileDiff(repo, entry.change,
      { id: parent, label: parent && entry.change.before ? shortId(parent) : undefined },
      { id: entry.commit.id, label: entry.change.after ? shortId(entry.commit.id) : undefined }, entry.line,
    );
  });
  register('copyCommitId', (item: HistoryItem) => vscode.env.clipboard.writeText(item.entry.commit.id));
  register('compareBranches', () => compare(chooseBranches));
  register('compareCommits', () => compare(chooseCommits));
  register('openComparedFile', (result: Comparison, change: Change) => openFileDiff(result.repo, change, result.base, result.target));
  register('openAllChanges', (item?: unknown) => comparison.openSelected(item));
  register('refreshComparison', (item?: unknown) => comparison.refresh(item));
  register('closeComparison', (item?: unknown) => comparison.close(item));
}
