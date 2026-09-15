export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Platform = 'windows' | 'macos' | 'linux';

export interface ResourceMeta {
  updatedAt: string;
  updatedBy: string;
}

/** Content of `meta.json` in the sync repository. Never part of content comparison. */
export interface RemoteMeta {
  schemaVersion: 1;
  resources: Record<string, ResourceMeta>;
}

/**
 * One side of a merge, reduced to the data that is compared.
 * `undefined` means the document does not exist on that side.
 */
export interface SyncView {
  settings?: JsonObject;
  /** Canonical JSON of the current platform's keybindings. */
  keybindings?: string;
  extensions?: string[];
}

/** Result of the last successful sync on this machine: the common ancestor for three-way merges. */
export interface SyncBase {
  commitSha: string;
  settings: JsonObject;
  keybindings: string;
  extensions: string[];
  meta: RemoteMeta;
}
