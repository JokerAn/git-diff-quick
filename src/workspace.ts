import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { findGitRoot, GitRepository } from './git';

export const snapshotScheme = 'git-diff-snapshot';

interface BuiltInGit {
  getAPI(version: 1): {
    git: { path: string };
    repositories: { rootUri: vscode.Uri }[];
  };
}

async function builtInGit() {
  const extension = vscode.extensions.getExtension<BuiltInGit>('vscode.git');
  try {
    return (await extension?.activate())?.getAPI(1);
  } catch {
    return undefined;
  }
}

function gitExecutable(uri?: vscode.Uri, detected?: string): string {
  const configured = vscode.workspace.getConfiguration('git', uri).get<string>('path');
  if (typeof configured === 'string' && configured) {
    return configured;
  }
  return detected ?? 'git';
}

export function isWorkingFile(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || uri.scheme === 'vscode-remote';
}

export async function fileRepository(uri: vscode.Uri, signal?: AbortSignal) {
  const executable = gitExecutable(uri, (await builtInGit())?.git.path);
  const directory = await realpath(dirname(uri.fsPath));
  const root = await findGitRoot(executable, directory, signal);
  if (!root) {
    throw new Error('当前文件不在 Git 仓库中。');
  }
  const path = relative(root, join(directory, basename(uri.fsPath)));
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('无法取得当前文件在 Git 仓库中的相对路径。');
  }
  return { repo: new GitRepository(root, executable), path: path.split(sep).join('/') };
}

export async function workspaceRepositories(active: vscode.Uri | undefined): Promise<GitRepository[]> {
  const api = await builtInGit();
  const executable = gitExecutable(active, api?.git.path);
  const directories = (vscode.workspace.workspaceFolders ?? [])
    .filter(folder => isWorkingFile(folder.uri))
    .map(folder => folder.uri.fsPath);

  if (active && isWorkingFile(active)) {
    directories.unshift(dirname(active.fsPath));
  }
  const discovered = await Promise.all([...new Set(directories)].map(directory => findGitRoot(executable, directory)));
  const builtInRoots = await Promise.all((api?.repositories ?? []).map(async repo => {
    const path = repo.rootUri.fsPath;
    return realpath(path).catch(() => path);
  }));
  const roots = new Set([...discovered, ...builtInRoots]);
  return [...roots].filter((root): root is string => Boolean(root))
    .map(root => new GitRepository(root, gitExecutable(vscode.Uri.file(root), api?.git.path)));
}

export function fileUri(repo: GitRepository, path: string): vscode.Uri {
  return vscode.Uri.joinPath(vscode.Uri.file(repo.root), path);
}

export function snapshotUri(repo: GitRepository, path: string, commit?: string): vscode.Uri {
  return vscode.Uri.from({ scheme: snapshotScheme, path: `/${path}`, query: JSON.stringify([repo.root, commit ?? null]) });
}

export async function snapshotContent(uri: vscode.Uri): Promise<string> {
  const [root, commit] = JSON.parse(uri.query) as [string, string | null];
  if (commit === null) {
    return '';
  }
  if (!isAbsolute(root) || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(commit)) {
    throw new Error('无效的 Git 快照地址。');
  }
  const executable = gitExecutable(vscode.Uri.file(root), (await builtInGit())?.git.path);
  return new GitRepository(root, executable).snapshot(commit, uri.path.slice(1));
}
