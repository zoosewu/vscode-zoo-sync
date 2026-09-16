import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LocalProfileInfo, LocalStore, TextFile } from '../sync/ports';
import type { Platform } from '../sync/types';
import { DEFAULT_PROFILE_NAME, findProfileForWorkspace, parseProfiles } from './profileStorage';
import { listMatchingFiles } from './walk';

const BACKUPS_TO_KEEP = 10;

export function currentPlatform(): Platform {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'linux';
  }
}

/**
 * `<user data dir>/User`. Global storage always lives in the default profile's `User/globalStorage/<id>`,
 * so this resolves correctly for portable mode, `--user-data-dir`, Insiders and forks — and it does not
 * change with the active profile, which is why profile directories are read from disk instead.
 */
export function userDirectory(context: vscode.ExtensionContext): string {
  return path.resolve(context.globalStorageUri.fsPath, '..', '..');
}

interface ManifestEntry {
  identifier?: { id?: string };
  relativeLocation?: string;
}

export class VSCodeLocalStore implements LocalStore {
  readonly platform = currentPlatform();
  readonly homeDir = homedir();
  private readonly userDir: string;
  private readonly storagePath: string;
  private readonly trashDir: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.userDir = userDirectory(context);
    this.storagePath = path.join(this.userDir, 'globalStorage', 'storage.json');
    this.trashDir = path.join(context.globalStorageUri.fsPath, 'trash');
  }

  async listProfiles(): Promise<LocalProfileInfo[]> {
    const storage = await readTextOrUndefined(this.storagePath);
    return parseProfiles(storage, this.userDir);
  }

  /** Read from VS Code's own storage: there is no API for the active profile. */
  async currentProfile(): Promise<string | undefined> {
    const workspace = vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspace) {
      return undefined;
    }
    const storage = await readTextOrUndefined(this.storagePath);
    return findProfileForWorkspace(storage, workspace.toString(), this.userDir);
  }

  canManageExtensions(): boolean {
    // In a remote window an install would land on the remote host instead of this machine.
    return !vscode.env.remoteName;
  }

  async readFile(file: string): Promise<TextFile | undefined> {
    try {
      const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      return { text: text.replace(/^﻿/, ''), mtime: info.mtimeMs };
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async writeFile(file: string, text: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
  }

  async deleteFile(file: string): Promise<void> {
    await this.backup(file);
    await rm(file, { force: true });
  }

  listFiles(dir: string, matches: (relativePath: string) => boolean, limit: number): Promise<string[]> {
    return listMatchingFiles(dir, matches, limit);
  }

  hasUnsavedChanges(paths: readonly string[]): boolean {
    if (paths.length === 0) {
      return false;
    }
    const targets = new Set(paths.map(comparablePath));
    // The settings JSON editor uses the vscode-userdata scheme, but its fsPath is still the file path.
    return vscode.workspace.textDocuments.some((doc) => doc.isDirty && targets.has(comparablePath(doc.uri.fsPath)));
  }

  /**
   * The profile manifest lists disabled extensions too; `vscode.extensions.all` does not, and would make
   * a disabled extension look uninstalled and remove it everywhere.
   */
  async listExtensions(profile: LocalProfileInfo): Promise<string[] | undefined> {
    const manifest = profile.isDefault
      ? path.join(path.dirname(this.context.extensionPath), 'extensions.json')
      : path.join(profile.dir, 'extensions.json');
    const ids = await this.readManifest(manifest);
    if (ids) {
      return ids;
    }
    // Development hosts and unusual installs have no readable manifest; the API covers the current profile.
    const current = (await this.currentProfile()) ?? DEFAULT_PROFILE_NAME;
    if (profile.name !== current) {
      return undefined;
    }
    return vscode.extensions.all
      .filter((extension) => !(extension.packageJSON as { isBuiltin?: boolean }).isBuiltin)
      .map((extension) => extension.id.toLowerCase())
      .filter((id) => id !== this.context.extension.id.toLowerCase());
  }

  async installExtension(id: string): Promise<void> {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
  }

  async uninstallExtension(id: string): Promise<void> {
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id);
  }

  private async readManifest(file: string): Promise<string[] | undefined> {
    const text = await readTextOrUndefined(file);
    if (text === undefined) {
      return undefined;
    }
    try {
      const entries = JSON.parse(text) as ManifestEntry[];
      const obsolete = await readTextOrUndefined(path.join(path.dirname(file), '.obsolete'));
      const removed = obsolete ? (JSON.parse(obsolete) as Record<string, boolean>) : {};
      return entries
        .filter((entry) => !(entry.relativeLocation && removed[entry.relativeLocation]))
        .flatMap((entry) => (entry.identifier?.id ? [entry.identifier.id.toLowerCase()] : []))
        .filter((id) => id !== this.context.extension.id.toLowerCase());
    } catch {
      return undefined;
    }
  }

  /** Keeps a copy of a file before it is deleted, so a wrong sync stays recoverable. */
  private async backup(file: string): Promise<void> {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = path.join(this.trashDir, stamp, path.basename(file));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(file, target);
      await this.pruneBackups();
    } catch {
      // A missing backup must never stop the sync.
    }
  }

  private async pruneBackups(): Promise<void> {
    const entries = await readdir(this.trashDir).catch(() => [] as string[]);
    for (const name of entries.sort().slice(0, Math.max(0, entries.length - BACKUPS_TO_KEEP))) {
      await rm(path.join(this.trashDir, name), { recursive: true, force: true });
    }
  }
}

async function readTextOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
}

function comparablePath(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'linux' ? normalized : normalized.toLowerCase();
}
