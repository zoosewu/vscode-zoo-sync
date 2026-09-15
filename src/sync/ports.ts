import type { Platform, SyncBase } from './types';

/** The remote branch moved between reading its head and updating it. */
export class NonFastForwardError extends Error {
  constructor() {
    super('Remote branch moved while uploading');
    this.name = 'NonFastForwardError';
  }
}

export interface RemoteStore {
  /** Branch head sha, or `undefined` when it still equals `knownSha`. */
  getHead(knownSha?: string): Promise<string | undefined>;
  /** File content at a commit, or `undefined` when the file does not exist. */
  readFile(commitSha: string, path: string): Promise<string | undefined>;
  /** Commits `files` on top of `parentSha` and fast-forwards the branch. Throws {@link NonFastForwardError}. */
  commit(parentSha: string, files: Record<string, string>, message: string): Promise<string>;
}

export interface TextFile {
  text: string;
  /** Last modification time in epoch milliseconds. */
  mtime: number;
}

export interface LocalStore {
  readonly platform: Platform;
  readSettings(): Promise<TextFile | undefined>;
  writeSettings(text: string): Promise<void>;
  readKeybindings(): Promise<TextFile | undefined>;
  writeKeybindings(text: string): Promise<void>;
  /** True when settings.json or keybindings.json is open with unsaved edits. */
  hasUnsavedChanges(): boolean;
  /** Installed extension ids, or `undefined` when this window cannot manage extensions (remote windows). */
  listExtensions(): Promise<string[] | undefined>;
  installExtension(id: string): Promise<void>;
  uninstallExtension(id: string): Promise<void>;
}

export interface LocalState {
  base?: SyncBase;
  /** Removed remotely, but the user chose to keep them on this machine. Never synced. */
  localOnlyExtensions: string[];
  /** Removed remotely and still waiting for the user to decide whether to uninstall. */
  pendingUninstall: string[];
  /** In the synced list, but installing them failed on this machine. Retried on every full sync. */
  unavailableExtensions: string[];
}

export function emptyState(): LocalState {
  return { localOnlyExtensions: [], pendingUninstall: [], unavailableExtensions: [] };
}

export interface StateStore {
  read(): Promise<LocalState>;
  write(state: LocalState): Promise<void>;
}

/** How a machine without sync history starts when the remote already has data. */
export type InitialSyncChoice = 'download' | 'upload' | 'merge';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
