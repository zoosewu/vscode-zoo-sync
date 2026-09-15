import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LocalStore, TextFile } from '../sync/ports';
import type { Platform } from '../sync/types';

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
 * so this resolves correctly for portable mode, `--user-data-dir`, Insiders and forks.
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
  private readonly settingsPath: string;
  private readonly keybindingsPath: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    const userDir = userDirectory(context);
    this.settingsPath = path.join(userDir, 'settings.json');
    this.keybindingsPath = path.join(userDir, 'keybindings.json');
  }

  readSettings(): Promise<TextFile | undefined> {
    return readTextFile(this.settingsPath);
  }

  writeSettings(text: string): Promise<void> {
    return writeTextFile(this.settingsPath, text);
  }

  readKeybindings(): Promise<TextFile | undefined> {
    return readTextFile(this.keybindingsPath);
  }

  writeKeybindings(text: string): Promise<void> {
    return writeTextFile(this.keybindingsPath, text);
  }

  hasUnsavedChanges(): boolean {
    const targets = new Set([this.settingsPath, this.keybindingsPath].map(comparablePath));
    // The settings JSON editor uses the vscode-userdata scheme, but its fsPath is still the file path.
    return vscode.workspace.textDocuments.some((doc) => doc.isDirty && targets.has(comparablePath(doc.uri.fsPath)));
  }

  async listExtensions(): Promise<string[] | undefined> {
    if (vscode.env.remoteName) {
      // Remote windows only see part of the list, and installs would land on the remote host.
      return undefined;
    }
    const ids = new Set(
      vscode.extensions.all
        .filter((ext) => !(ext.packageJSON as { isBuiltin?: boolean }).isBuiltin)
        .map((ext) => ext.id.toLowerCase()),
    );
    for (const id of await this.readInstalledManifest()) {
      ids.add(id);
    }
    ids.delete(this.context.extension.id.toLowerCase());
    return [...ids];
  }

  async installExtension(id: string): Promise<void> {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
  }

  async uninstallExtension(id: string): Promise<void> {
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id);
  }

  /**
   * `vscode.extensions.all` omits disabled extensions. The extensions folder manifest lists them too;
   * without it a disabled extension would look uninstalled and be removed from every machine.
   */
  private async readInstalledManifest(): Promise<string[]> {
    if (this.context.extensionMode !== vscode.ExtensionMode.Production) {
      return [];
    }
    const extensionsDir = path.dirname(this.context.extensionPath);
    try {
      const entries = JSON.parse(await readFile(path.join(extensionsDir, 'extensions.json'), 'utf8')) as ManifestEntry[];
      const obsolete = await readFile(path.join(extensionsDir, '.obsolete'), 'utf8')
        .then((text) => JSON.parse(text) as Record<string, boolean>)
        .catch(() => ({}) as Record<string, boolean>);
      return entries
        .filter((entry) => !(entry.relativeLocation && obsolete[entry.relativeLocation]))
        .flatMap((entry) => (entry.identifier?.id ? [entry.identifier.id.toLowerCase()] : []));
    } catch {
      return [];
    }
  }
}

async function readTextFile(file: string): Promise<TextFile | undefined> {
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return { text: text.replace(/^﻿/, ''), mtime: info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeTextFile(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

function comparablePath(file: string): string {
  const normalized = path.normalize(file);
  return process.platform === 'linux' ? normalized : normalized.toLowerCase();
}
