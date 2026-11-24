import { posix } from 'node:path';
import * as vscode from 'vscode';
import { commitDate, Comparison, shortId } from './comparison';
import { Change, GitRepository, HistoryEntry } from './git';
import { fileUri } from './workspace';

export class ResultTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  private items: vscode.TreeItem[] = [];
  readonly onDidChangeTreeData = this.changed.event;

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
    return this.items;
  }

  update(items: vscode.TreeItem[]) {
    this.items = items;
    this.changed.fire();
  }

  dispose() {
    this.changed.dispose();
  }
}

export class HistoryItem extends vscode.TreeItem {
  constructor(repo: GitRepository, readonly entry: HistoryEntry) {
    const { commit, change } = entry;
    super(commit.subject || '（无提交说明）');
    this.id = commit.id;
    this.iconPath = new vscode.ThemeIcon('git-commit');
    this.contextValue = 'gitDiff.commit';
    this.description = `${shortId(commit.id)} · ${commit.author} · ${commitDate(commit)}`;
    this.tooltip = new vscode.MarkdownString().appendText([
      this.label, commit.id, `${commit.author} · ${commitDate(commit)}`,
      change.before !== change.after && change.before && change.after ? `${change.before} → ${change.after}` : change.after ?? change.before,
    ].join('\n\n'));
    this.command = { title: '查看该提交的文件变更', command: 'gitDiff.openHistoryEntry', arguments: [repo, entry] };
  }
}

const statusLabels: Record<string, string> = { A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', T: '类型变更' };

export class ComparisonItem extends vscode.TreeItem {
  constructor(comparison: Comparison, change: Change) {
    const path = (change.after ?? change.before)!;
    super(posix.basename(path));
    this.resourceUri = fileUri(comparison.repo, path);
    this.iconPath = vscode.ThemeIcon.File;
    const status = statusLabels[change.status] ?? change.status;
    const directory = posix.dirname(path);
    this.description = directory === '.' ? status : `${status} · ${directory}`;
    this.tooltip = `${status} · ${change.before && change.after && change.before !== change.after ? `${change.before} → ${change.after}` : path}`;
    this.command = { title: '查看文件比较', command: 'gitDiff.openComparedFile', arguments: [comparison, change] };
  }
}
