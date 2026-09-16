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
  /** Every file in the commit, mapped to its git blob id. */
  listTree(commitSha: string): Promise<Map<string, string>>;
  /** File content at a commit, or `undefined` when the file does not exist. */
  readFile(commitSha: string, path: string): Promise<string | undefined>;
  /** Commits the given writes and deletions on top of `parentSha`. Throws {@link NonFastForwardError}. */
  commit(
    parentSha: string,
    files: Record<string, string>,
    deletions: readonly string[],
    message: string,
  ): Promise<string>;
}

export interface TextFile {
  text: string;
  /** Last modification time in epoch milliseconds. */
  mtime: number;
}

export interface UseDefaultFlags {
  settings?: boolean;
  keybindings?: boolean;
  tasks?: boolean;
  snippets?: boolean;
  prompts?: boolean;
  mcp?: boolean;
  extensions?: boolean;
  globalState?: boolean;
}

export interface LocalProfileInfo {
  name: string;
  /** Absolute path of the profile directory; the Default profile uses the User directory itself. */
  dir: string;
  isDefault: boolean;
  useDefaultFlags?: UseDefaultFlags;
}

export interface LocalStore {
  readonly platform: Platform;
  /** Absolute path of the user's home directory. */
  readonly homeDir: string;
  /** Profiles that exist on this machine, Default first. */
  listProfiles(): Promise<LocalProfileInfo[]>;
  /** Profile of the current window, or `undefined` when it cannot be determined. */
  currentProfile(): Promise<string | undefined>;
  /** False in windows where installing extensions would land somewhere else (remote windows). */
  canManageExtensions(): boolean;
  readFile(path: string): Promise<TextFile | undefined>;
  writeFile(path: string, text: string): Promise<void>;
  /** Removes a file after keeping a copy, so a wrong sync is recoverable. */
  deleteFile(path: string): Promise<void>;
  /** Relative paths under `dir` that `matches` accepts, skipping symlinks and unreadable entries. */
  listFiles(dir: string, matches: (relativePath: string) => boolean, limit: number): Promise<string[]>;
  /** True when one of these files is open with unsaved edits. */
  hasUnsavedChanges(paths: readonly string[]): boolean;
  /** Extension ids installed in a profile, or `undefined` when the list cannot be read. */
  listExtensions(profile: LocalProfileInfo): Promise<string[] | undefined>;
  installExtension(id: string): Promise<void>;
  uninstallExtension(id: string): Promise<void>;
}

/** Extensions a machine treats differently from the synced list, per profile. */
export interface ExtensionState {
  /** Removed remotely, but the user chose to keep them here. Never synced. */
  localOnly: string[];
  /** Removed remotely and still waiting for the user to decide. */
  pendingUninstall: string[];
  /** In the synced list, but installing them failed here. Retried on every full sync. */
  unavailable: string[];
}

export interface PendingDeletion {
  remotePath: string;
  localPath: string;
}

export interface LocalState {
  base?: SyncBase;
  /** Keyed by profile name. */
  extensions: Record<string, ExtensionState>;
  /** Files deleted elsewhere, waiting for the user to confirm deleting them here. */
  pendingDeletions: PendingDeletion[];
  /** Remote paths the user chose to keep locally after they were deleted elsewhere. Never synced. */
  localOnlyFiles: string[];
}

export function emptyState(): LocalState {
  return { extensions: {}, pendingDeletions: [], localOnlyFiles: [] };
}

export function emptyExtensionState(): ExtensionState {
  return { localOnly: [], pendingUninstall: [], unavailable: [] };
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
