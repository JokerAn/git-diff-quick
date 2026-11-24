import { basename } from 'node:path';
import * as vscode from 'vscode';
import { GitRepository, LineMapper, LineRange } from './git';
import { HistoryItem, ResultTree } from './views';
import { fileRepository, isWorkingFile } from './workspace';

type HistoryMode = 'file' | 'line';

interface LineSelection {
  document: vscode.TextDocument;
  version: number;
  range: LineRange;
}

interface HistoryTarget {
  file: vscode.Uri;
  key: string;
  label: string;
  line?: LineSelection;
}

interface HistoryQuery {
  repo: GitRepository;
  head: string;
  path: string;
  ranges?: LineRange[];
}

interface HistoryRequest {
  id: number;
  target: HistoryTarget;
  abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
}

const pageSize = 80;
const fileDelayMs = 100;
const lineDelayMs = 250;

function getTarget(mode: HistoryMode, editor: vscode.TextEditor | undefined, uri?: vscode.Uri): HistoryTarget | undefined {
  const file = uri ?? editor?.document.uri;
  if (!file || !isWorkingFile(file)) {
    return;
  }
  const key = file.toString();
  const label = basename(file.fsPath);
  if (mode === 'file') {
    return { file, key, label };
  }
  if (!editor || editor.document.uri.toString() !== key) {
    return;
  }

  const { document, selection } = editor;
  const start = selection.start.line + 1;
  const endsAtNextLine = selection.end.line > selection.start.line && selection.end.character === 0;
  const end = selection.end.line + (endsAtNextLine ? 0 : 1);
  const lineLabel = start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
  return { file, key, label: `${label} · ${lineLabel}`, line: { document, version: document.version, range: { start, end } } };
}

function sameTarget(a: HistoryTarget, b: HistoryTarget): boolean {
  return a.key === b.key && a.line?.document === b.line?.document && a.line?.version === b.line?.version
    && a.line?.range.start === b.line?.range.start && a.line?.range.end === b.line?.range.end;
}

export class HistoryController implements vscode.Disposable {
  private readonly tree = new ResultTree();
  private readonly view = vscode.window.createTreeView('gitDiff.history', { treeDataProvider: this.tree });
  private readonly subscriptions: vscode.Disposable[];
  private mode: HistoryMode = 'file';
  private sequence = 0;
  private current?: HistoryRequest;
  private focusing?: HistoryRequest;
  private location?: { key: string; repo: GitRepository; path: string };
  private mapper?: { document: vscode.TextDocument; version: number; head: string; path: string; map: LineMapper };

  constructor() {
    this.subscriptions = [
      vscode.window.onDidChangeActiveTextEditor(() => this.followEditor()),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (this.mode === 'line' && event.textEditor === vscode.window.activeTextEditor) {
          this.followEditor();
        }
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (this.mode === 'line' && event.contentChanges.length && event.document === vscode.window.activeTextEditor?.document) {
          this.followEditor();
        }
      }),
      this.view.onDidChangeVisibility(() => this.followEditor()),
    ];
    this.followEditor();
  }

  dispose() {
    this.cancel();
    vscode.Disposable.from(...this.subscriptions, this.view, this.tree).dispose();
  }

  async browse(mode: HistoryMode, context?: unknown) {
    const uri = context instanceof vscode.Uri ? context : undefined;
    const target = getTarget(mode, vscode.window.activeTextEditor, uri);
    if (!target) {
      const message = mode === 'line' ? '请先在 Git 文件中定位或选中要查询的行。' : '请先打开 Git 仓库中的文件。';
      void vscode.window.showInformationMessage(`Git Diff · ${message}`);
      return;
    }
    this.mode = mode;
    this.location = undefined;
    const request = this.replace(target);
    this.focusing = request;
    try {
      await vscode.commands.executeCommand('gitDiff.history.focus');
    } finally {
      if (this.focusing === request) {
        this.focusing = undefined;
      }
    }
    await this.load(request, true);
  }

  async more(id: number, query: HistoryQuery, limit: number) {
    const request = this.current;
    if (!request || request.id !== id || request.busy || !this.view.visible) {
      return;
    }
    request.busy = true;
    try {
      await this.readPage(request, query, limit);
    } catch (error) {
      if (!request.abort.signal.aborted) {
        throw error;
      }
    } finally {
      request.busy = false;
    }
  }

  private followEditor() {
    if (this.focusing && this.focusing === this.current) {
      return;
    }
    const target = this.view.visible ? getTarget(this.mode, vscode.window.activeTextEditor) : undefined;
    if (!target) {
      if (this.current?.busy) {
        this.cancel();
      }
      return;
    }
    if (this.current && sameTarget(this.current.target, target)) {
      return;
    }
    const delay = target.line && this.current?.target.key === target.key ? lineDelayMs : fileDelayMs;
    const request = this.replace(target);
    request.timer = setTimeout(() => {
      request.timer = undefined;
      void this.load(request);
    }, delay);
  }

  private cancel() {
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.abort.abort();
      this.current = undefined;
    }
  }

  private replace(target: HistoryTarget): HistoryRequest {
    this.cancel();
    const request = { id: ++this.sequence, target, abort: new AbortController(), busy: true };
    this.current = request;
    return request;
  }

  private async load(request: HistoryRequest, manual = false) {
    const { target, abort: { signal } } = request;
    if (signal.aborted) {
      return;
    }
    try {
      const query = await this.getQuery(target, signal);
      signal.throwIfAborted();
      if (!query || query.ranges?.length === 0) {
        this.show(request, [], query ? '选区没有能对应到 HEAD 的行。' : '当前仓库还没有提交。');
        return;
      }
      await this.readPage(request, query, pageSize);
    } catch (error) {
      if (!signal.aborted) {
        this.show(request, [], error instanceof Error ? error.message : String(error));
        if (manual) {
          throw error;
        }
      }
    } finally {
      request.busy = false;
    }
  }

  private async getQuery(target: HistoryTarget, signal: AbortSignal): Promise<HistoryQuery | undefined> {
    if (this.location?.key !== target.key) {
      const location = await fileRepository(target.file, signal);
      signal.throwIfAborted();
      this.location = { key: target.key, ...location };
    }
    const { repo, path: filePath } = this.location;
    const head = await repo.resolveCommit('HEAD', signal);
    if (!head) {
      return;
    }
    const path = await repo.historyPath(head, filePath, signal);
    let ranges: LineRange[] | undefined;
    if (target.line) {
      const { document, version, range } = target.line;
      const cached = this.mapper;
      if (cached?.document === document && cached.version === version && cached.head === head && cached.path === path) {
        ranges = cached.map(range);
      } else {
        signal.throwIfAborted();
        const map = await repo.lineMapper(head, path, document.getText(), signal);
        signal.throwIfAborted();
        this.mapper = { document, version, head, path, map };
        ranges = map(range);
      }
    }
    return { repo, head, path, ranges };
  }

  private async readPage(request: HistoryRequest, query: HistoryQuery, limit: number) {
    const { repo, head, path, ranges } = query;
    const signal = request.abort.signal;
    const entries = await vscode.window.withProgress({ location: { viewId: 'gitDiff.history' }, title: '读取 Git 历史' }, () =>
      ranges ? repo.lineHistory(head, path, ranges, limit + 1, signal) : repo.fileHistory(head, path, limit + 1, signal),
    );
    signal.throwIfAborted();
    const items: vscode.TreeItem[] = entries.slice(0, limit).map(entry => new HistoryItem(repo, entry));
    if (entries.length > limit) {
      const more = new vscode.TreeItem('查看更多历史');
      more.iconPath = new vscode.ThemeIcon('ellipsis');
      more.command = { title: '查看更多历史', command: 'gitDiff.moreHistory', arguments: [request.id, query, limit + pageSize] };
      items.push(more);
    }
    this.show(request, items, entries.length ? undefined : '没有找到对应的提交记录。');
  }

  private show(request: HistoryRequest, items: vscode.TreeItem[], message?: string) {
    this.view.description = request.target.label;
    this.view.message = message;
    this.tree.update(items);
  }
}
