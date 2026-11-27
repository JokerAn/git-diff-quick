import * as vscode from 'vscode';
import { Comparison, comparisonTitle, openAllChanges, shortId } from './comparison';
import { GitRepository, Revision } from './git';
import { ComparisonItem } from './views';

function comparisonTabNumber(tab?: vscode.Tab): number | undefined {
  // Multi-file diff inputs are exposed as unknown by the stable Tab API.
  if (!tab || typeof tab.input !== 'object' || tab.input === null || !('textDiffs' in tab.input)) {
    return;
  }
  const match = /^Git Diff #(\d+) · /.exec(tab.label);
  return match ? Number(match[1]) : undefined;
}

class ComparisonGroup extends vscode.TreeItem {
  refreshing?: AbortController;
  opening = false;

  constructor(readonly number: number, public comparison: Comparison) {
    super(comparisonTitle(comparison), vscode.TreeItemCollapsibleState.Expanded);
    this.id = `gitDiff.comparison.${number}`;
    this.iconPath = new vscode.ThemeIcon('diff');
    this.command = { title: '打开全部变更', command: 'gitDiff.openAllChanges', arguments: [this] };
    this.update(comparison);
  }

  get titlePrefix() {
    return `Git Diff #${this.number} · `;
  }

  update(comparison: Comparison) {
    this.comparison = comparison;
    const { repo, base, target, changes } = comparison;
    this.contextValue = base.ref || target.ref ? 'gitDiff.branchComparison' : 'gitDiff.commitComparison';
    this.description = `${changes.length} 个文件`;
    this.tooltip = `${comparisonTitle(comparison)}\n${shortId(base.id)} → ${shortId(target.id)}\n${repo.root}`;
  }
}

export class ComparisonView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view = vscode.window.createTreeView('gitDiff.comparison', { treeDataProvider: this });
  private readonly groups = new Map<number, ComparisonGroup>();
  private readonly tabsChanged = vscode.window.tabGroups.onDidChangeTabs(event => {
    for (const tab of event.closed) {
      const group = this.groupForTab(tab);
      if (group && !group.opening && !this.tabsFor(group).length) {
        this.remove(group);
      }
    }
    this.updateContext();
  });
  private readonly tabGroupsChanged = vscode.window.tabGroups.onDidChangeTabGroups(() => this.updateContext());
  private sequence = 0;
  private editorQueue = Promise.resolve();

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(item?: vscode.TreeItem): vscode.TreeItem[] {
    if (!item) {
      return [...this.groups.values()];
    }
    if (!(item instanceof ComparisonGroup) || !this.groups.has(item.number)) {
      return [];
    }
    const { comparison } = item;
    return comparison.changes.length
      ? comparison.changes.map(change => new ComparisonItem(comparison, change))
      : [new vscode.TreeItem('两个版本的文件内容相同。')];
  }

  dispose() {
    for (const group of this.groups.values()) {
      group.refreshing?.abort();
    }
    this.groups.clear();
    vscode.Disposable.from(this.view, this.changed, this.tabsChanged, this.tabGroupsChanged).dispose();
  }

  async compare(repo: GitRepository, base: Revision, target: Revision) {
    const comparison = await this.load(repo, base, target);
    let group: ComparisonGroup;
    do {
      group = new ComparisonGroup(++this.sequence, comparison);
    } while (this.tabsFor(group).length);
    this.groups.set(group.number, group);
    this.changed.fire(undefined);
    this.updateContext();
    try {
      await vscode.commands.executeCommand('gitDiff.comparison.focus');
      await this.open(group);
    } catch (error) {
      await this.close(group);
      throw error;
    }
  }

  async openSelected(item?: unknown) {
    const selected = this.view.selection[0];
    const group = this.selectedGroup(item)
      ?? (item instanceof ComparisonGroup ? undefined : this.selectedGroup(selected) ?? [...this.groups.values()].at(-1));
    if (group) {
      await this.open(group);
    }
  }

  async refresh(item?: unknown) {
    const group = this.selectedGroup(item);
    if (!group || group.refreshing || group.contextValue !== 'gitDiff.branchComparison') {
      return;
    }
    const request = new AbortController();
    group.refreshing = request;
    const { repo, base, target } = group.comparison;
    try {
      const result = await this.load(repo, base, target, request.signal);
      if (request.signal.aborted || (base.id === result.base.id && target.id === result.target.id)) {
        return;
      }
      await this.open(group, result);
    } catch (error) {
      if (!request.signal.aborted) {
        throw error;
      }
    } finally {
      group.refreshing = undefined;
    }
  }

  async close(item?: unknown) {
    const group = this.selectedGroup(item);
    if (!group) {
      return;
    }
    this.remove(group);
    await this.editorQueue;
    const tabs = this.tabsFor(group);
    if (tabs.length) {
      await vscode.window.tabGroups.close(tabs);
    }
  }

  private async load(repo: GitRepository, base: Revision, target: Revision, signal?: AbortSignal): Promise<Comparison> {
    const result = await vscode.window.withProgress({ location: { viewId: 'gitDiff.comparison' }, title: '比较 Git 变更' }, () =>
      repo.compareRevisions(base, target, signal),
    );
    return { repo, ...result };
  }

  private async open(group: ComparisonGroup, updated?: Comparison) {
    // vscode.changes opens a preview. Keep each result before another comparison can open.
    const opening = this.editorQueue.then(async () => {
      if (!this.groups.has(group.number) || (!updated && this.selectedGroup() === group)) {
        return;
      }
      const previous = this.tabsFor(group);
      group.opening = true;
      try {
        const comparison = updated ?? group.comparison;
        await openAllChanges(comparison, group.titlePrefix + comparisonTitle(comparison));
        const active = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (active?.isPreview && comparisonTabNumber(active) === group.number) {
          await vscode.commands.executeCommand('workbench.action.keepEditor');
        }
        if (!this.groups.has(group.number)) {
          return;
        }
        if (updated) {
          group.update(updated);
          this.changed.fire(group);
        }
        const remaining = this.tabsFor(group).filter(tab => previous.includes(tab));
        if (remaining.length) {
          await vscode.window.tabGroups.close(remaining);
        }
      } finally {
        group.opening = false;
        if (this.groups.has(group.number) && !this.tabsFor(group).length) {
          this.remove(group);
        }
      }
    });
    this.editorQueue = opening.catch(() => {});
    await opening;
  }

  private selectedGroup(item?: unknown) {
    if (item instanceof ComparisonGroup) {
      return this.groups.get(item.number);
    }
    return this.groupForTab(vscode.window.tabGroups.activeTabGroup.activeTab);
  }

  private groupForTab(tab?: vscode.Tab) {
    const number = comparisonTabNumber(tab);
    return number === undefined ? undefined : this.groups.get(number);
  }

  private tabsFor(group: ComparisonGroup) {
    return vscode.window.tabGroups.all.flatMap(tabGroup => tabGroup.tabs.filter(tab => comparisonTabNumber(tab) === group.number));
  }

  private remove(group: ComparisonGroup) {
    group.refreshing?.abort();
    this.groups.delete(group.number);
    this.changed.fire(undefined);
    this.updateContext();
  }

  private updateContext() {
    void vscode.commands.executeCommand('setContext', 'gitDiff.hasComparison', this.groups.size > 0);
    void vscode.commands.executeCommand('setContext', 'gitDiff.activeBranchComparison', this.selectedGroup()?.contextValue === 'gitDiff.branchComparison');
  }
}
