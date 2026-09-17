import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalize } from './canonical';
import { mapLegacyMetaKey, mapSchema2Path } from './legacy';
import { emptyState, type LocalState, type StateStore } from './ports';
import type { BaseResource, JsonObject, Platform, RemoteMeta } from './types';

const VERSION = 3;

interface StateFile extends LocalState {
  version: number;
  repository: string;
}

/** The schema 1 file, kept readable so an upgrade does not ask the user how to start again. */
interface LegacyStateFile {
  version?: number;
  repository: string;
  base?: {
    commitSha: string;
    settings: JsonObject;
    keybindings: string;
    extensions: string[];
    meta: RemoteMeta;
  };
  localOnlyExtensions?: string[];
  pendingUninstall?: string[];
  unavailableExtensions?: string[];
}

/**
 * Sync state in a JSON file under global storage. Every VS Code window reads it fresh,
 * unlike `globalState`, whose cached values can lag behind other windows.
 */
export class FileStateStore implements StateStore {
  /** @param repository `owner/name@branch`; state recorded for another repository is ignored. */
  constructor(
    private readonly file: string,
    private readonly repository: string,
    private readonly platform: Platform,
    private readonly appId: string = 'code',
  ) {}

  async read(): Promise<LocalState> {
    let data: Partial<StateFile> & LegacyStateFile;
    try {
      data = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StateFile> & LegacyStateFile;
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyState();
      }
      throw error;
    }
    if (data.repository !== this.repository) {
      return emptyState();
    }
    const version = data.version ?? 1;
    if (version < VERSION) {
      return this.upgrade(data, version);
    }
    return {
      base: data.base,
      extensions: data.extensions ?? {},
      pendingDeletions: data.pendingDeletions ?? [],
      localOnlyFiles: data.localOnlyFiles ?? [],
    };
  }

  async write(state: LocalState): Promise<void> {
    const content: StateFile = { version: VERSION, repository: this.repository, ...state };
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(content, null, 2));
    await rename(temp, this.file);
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }

  /** Renames older state onto the current layout; blob ids are unknown, so files are read once more. */
  private upgrade(data: LegacyStateFile & Partial<StateFile>, version: number): LocalState {
    if (version === 2) {
      return {
        base: data.base && {
          ...data.base,
          resources: Object.fromEntries(
            Object.entries(data.base.resources).map(([path, entry]) => [mapSchema2Path(path, this.appId) ?? path, entry]),
          ),
          meta: {
            schemaVersion: 3,
            resources: Object.fromEntries(
              Object.entries(data.base.meta?.resources ?? {}).map(([key, value]) => [
                mapSchema2Path(key, this.appId) ?? key,
                value,
              ]),
            ),
          },
        },
        extensions: data.extensions ?? {},
        pendingDeletions: data.pendingDeletions ?? [],
        localOnlyFiles: data.localOnlyFiles ?? [],
      };
    }
    const state = emptyState();
    if (data.localOnlyExtensions?.length || data.pendingUninstall?.length || data.unavailableExtensions?.length) {
      state.extensions.Default = {
        localOnly: data.localOnlyExtensions ?? [],
        pendingUninstall: data.pendingUninstall ?? [],
        unavailable: data.unavailableExtensions ?? [],
      };
    }
    const legacy = data.base;
    if (!legacy) {
      return state;
    }
    // A hand-edited or truncated legacy file may be missing pieces; those simply have no base entry.
    const extensionsPath = `profiles/Default/extensions.${this.appId}.json`;
    const resources: Record<string, BaseResource> = {};
    if (legacy.settings) {
      resources['profiles/Default/settings.json'] = { canonical: canonicalize(legacy.settings), blobSha: '' };
    }
    if (legacy.extensions) {
      resources[extensionsPath] = { canonical: canonicalize(legacy.extensions), blobSha: '' };
    }
    if (typeof legacy.keybindings === 'string') {
      resources[`profiles/Default/keybindings/${this.platform}.json`] = {
        canonical: legacy.keybindings,
        blobSha: '',
      };
    }
    const metaResources: RemoteMeta['resources'] = {};
    for (const [key, value] of Object.entries(legacy.meta?.resources ?? {})) {
      const mapped = mapLegacyMetaKey(key);
      if (mapped) {
        metaResources[mapSchema2Path(mapped, this.appId) ?? mapped] = value;
      }
    }
    state.base = {
      commitSha: legacy.commitSha,
      resources,
      meta: { schemaVersion: 3, resources: metaResources },
    };
    return state;
  }
}
