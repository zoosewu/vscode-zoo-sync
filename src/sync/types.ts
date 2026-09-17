export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Platform = 'windows' | 'macos' | 'linux';

export interface ResourceMeta {
  updatedAt: string;
  updatedBy: string;
}

/** Content of `meta.json`. Never part of content comparison. */
export interface RemoteMeta {
  /** 1 was flat and single-profile, 2 added profiles, 3 gives each editor its own extension list. */
  schemaVersion: 1 | 2 | 3;
  /** Keyed by remote path in schema 2. */
  resources: Record<string, ResourceMeta>;
}

/** What the last successful sync left behind: the common ancestor for three-way merges. */
export interface SyncBase {
  commitSha: string;
  /** Keyed by remote path. */
  resources: Record<string, BaseResource>;
  meta: RemoteMeta;
}

export interface BaseResource {
  /** Normalized content, used for comparison. */
  canonical: string;
  /** Git blob id of the remote bytes, so unchanged files are never downloaded again. */
  blobSha: string;
}
