import { jsonEquals } from './canonical';
import {
  applySettingsChanges,
  canonicalKeybindings,
  normalizeExtensionIds,
  omitKeys,
  parseExtensionList,
  parseMeta,
  parseSettings,
  removeSettings,
  serializeExtensionList,
  serializeMeta,
} from './documents';
import { createExtensionFilter, createSettingFilter, looksLikeSecret } from './ignore';
import { mergeExtensions, mergeKeybindings, mergeSettings, type ConflictWinner } from './merge';
import {
  NonFastForwardError,
  type InitialSyncChoice,
  type LocalStore,
  type Logger,
  type RemoteStore,
  type StateStore,
} from './ports';
import type { Platform, RemoteMeta, SyncBase, SyncView } from './types';

export const REMOTE_FILES = {
  meta: 'meta.json',
  settings: 'settings.json',
  extensions: 'extensions.json',
  keybindings: (platform: Platform) => `keybindings/${platform}.json`,
};

const MAX_ATTEMPTS = 3;

export interface EngineConfig {
  ignoredSettings: readonly string[];
  ignoredExtensions: readonly string[];
}

export interface EngineDeps {
  local: LocalStore;
  remote: RemoteStore;
  state: StateStore;
  logger: Logger;
  config: EngineConfig;
  /** Written to `updatedBy`, e.g. `linux@hostname`. */
  machine: string;
  now?: () => Date;
}

export interface SyncOptions {
  /** Whether local files may have changed since the last sync. */
  localChanged: boolean;
  /** Required when this machine has never synced and the remote already has data. */
  initialChoice?: InitialSyncChoice;
}

export interface SyncReport {
  outcome: 'up-to-date' | 'synced' | 'skipped' | 'needs-initial-choice';
  reason?: string;
  commitSha?: string;
  uploaded: string[];
  applied: string[];
  conflicts: string[];
  installed: string[];
  /** Installed here but removed remotely; resolve with {@link SyncEngine.resolvePendingUninstall}. */
  pendingUninstall: string[];
}

interface RemoteSnapshot {
  view: SyncView;
  meta: RemoteMeta;
  /** Raw text of this platform's keybindings, kept so comments survive a download. */
  keybindingsText?: string;
}

/**
 * Non-interactive sync: decisions that need the user come back in the report,
 * so the caller can ask without holding the sync lock.
 */
export class SyncEngine {
  private readonly now: () => Date;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Runs one sync cycle. With `localChanged: false` and an unchanged remote head this costs a single
   * conditional request and touches nothing locally.
   */
  async sync(options: SyncOptions): Promise<SyncReport> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt({ ...options, localChanged: options.localChanged || attempt > 1 });
      } catch (error) {
        if (!(error instanceof NonFastForwardError) || attempt >= MAX_ATTEMPTS) {
          throw error;
        }
        this.deps.logger.warn(`Remote branch moved during upload; retrying (${attempt}/${MAX_ATTEMPTS - 1}).`);
      }
    }
  }

  /** Uninstalls the chosen pending extensions. The rest stay on this machine and are no longer synced. */
  async resolvePendingUninstall(chosen: readonly string[]): Promise<string[]> {
    const { local, logger } = this.deps;
    const state = await this.deps.state.read();
    const uninstalled: string[] = [];
    const kept: string[] = [];
    for (const id of state.pendingUninstall) {
      if (!chosen.includes(id)) {
        kept.push(id);
        continue;
      }
      try {
        await local.uninstallExtension(id);
        uninstalled.push(id);
        logger.info(`Uninstalled extension ${id}.`);
      } catch (error) {
        kept.push(id);
        logger.warn(`Could not uninstall extension ${id}: ${errorMessage(error)}`);
      }
    }
    await this.deps.state.write({
      ...state,
      localOnlyExtensions: normalizeExtensionIds([...state.localOnlyExtensions, ...kept]),
      pendingUninstall: [],
    });
    return uninstalled;
  }

  private async attempt(options: SyncOptions): Promise<SyncReport> {
    const { local, remote, logger, config } = this.deps;
    const state = await this.deps.state.read();
    const knownSha = state.base?.commitSha;
    const headSha = (await remote.getHead(knownSha)) ?? knownSha;
    if (headSha === undefined) {
      throw new Error('Remote branch head is unavailable');
    }
    const remoteChanged = headSha !== knownSha;
    if (!remoteChanged && !options.localChanged) {
      return report('up-to-date', { commitSha: headSha });
    }
    if (local.hasUnsavedChanges()) {
      return report('skipped', { reason: 'settings.json or keybindings.json has unsaved changes' });
    }

    const isIgnoredSetting = createSettingFilter(config.ignoredSettings);
    const isIgnoredExtension = createExtensionFilter(config.ignoredExtensions);

    // Local side.
    const settingsFile = await local.readSettings();
    const keybindingsFile = await local.readKeybindings();
    const allLocalSettings = parseSettings(settingsFile?.text);
    const secretKeys = Object.keys(allLocalSettings).filter(looksLikeSecret);
    if (secretKeys.length > 0) {
      logger.info(`Not syncing secret-like settings: ${secretKeys.join(', ')}`);
    }
    const localSettings = omitKeys(allLocalSettings, isIgnoredSetting);
    const localKeybindings = canonicalKeybindings(keybindingsFile?.text);
    const installed = await local.listExtensions();
    const installedIds = installed && normalizeExtensionIds(installed);

    // Remote side. When the head did not move, the remote still equals the base.
    const remoteSnapshot =
      state.base && !remoteChanged ? snapshotFromBase(state.base) : await this.readRemote(headSha, isIgnoredSetting);
    const remoteView = remoteSnapshot.view;
    const remoteExtensions = remoteView.extensions ?? state.base?.extensions ?? [];

    // Extensions not managed on this machine mirror the remote, so they never look changed locally.
    const localOnly = state.localOnlyExtensions.filter((id) => !remoteExtensions.includes(id));
    const pending = state.pendingUninstall.filter((id) => !remoteExtensions.includes(id));
    const unavailable = new Set(state.unavailableExtensions.filter((id) => remoteExtensions.includes(id)));
    const isExcluded = (id: string) =>
      isIgnoredExtension(id) || localOnly.includes(id) || pending.includes(id) || unavailable.has(id);
    const localExtensions = installedIds
      ? normalizeExtensionIds([...installedIds.filter((id) => !isExcluded(id)), ...remoteExtensions.filter(isExcluded)])
      : remoteExtensions;
    const localView: SyncView = { settings: localSettings, keybindings: localKeybindings, extensions: localExtensions };

    let base: SyncView;
    let forcedWinner: ConflictWinner | undefined;
    if (state.base) {
      base = snapshotFromBase(state.base).view;
    } else if (isEmptyView(remoteView)) {
      base = remoteView;
    } else if (!options.initialChoice) {
      return report('needs-initial-choice');
    } else {
      logger.info(`First sync on this machine: ${options.initialChoice}.`);
      if (options.initialChoice === 'download') {
        base = localView;
      } else if (options.initialChoice === 'upload') {
        base = remoteView;
      } else {
        base = { settings: {}, extensions: [] };
        forcedWinner = 'remote';
      }
    }

    // Merge. Conflicts go to the side with the newer update time.
    const platform = local.platform;
    const keybindingsResource = `keybindings.${platform}`;
    const remoteTime = (resource: string) => Date.parse(remoteSnapshot.meta.resources[resource]?.updatedAt ?? '') || 0;
    const winnerFor = (resource: string, localMtime: number | undefined): ConflictWinner =>
      forcedWinner ?? ((localMtime ?? 0) > remoteTime(resource) ? 'local' : 'remote');

    const settingsWinner = winnerFor('settings', settingsFile?.mtime);
    const settings = mergeSettings(base.settings, localSettings, remoteView.settings, settingsWinner);
    const keybindingsWinner = winnerFor(keybindingsResource, keybindingsFile?.mtime);
    const keybindings = mergeKeybindings(base.keybindings, localKeybindings, remoteView.keybindings, keybindingsWinner);
    const extensions = mergeExtensions(base.extensions, localExtensions, remoteView.extensions);

    const conflicts = settings.conflicts.map((key) => `settings:${key}`);
    for (const key of settings.conflicts) {
      logger.warn(`Conflict on setting "${key}": kept the ${settingsWinner} value (newer update time).`);
    }
    if (keybindings.conflict) {
      conflicts.push(keybindingsResource);
      logger.warn(`Conflict on ${keybindingsResource}: kept the ${keybindingsWinner} file (newer update time).`);
    }

    // Upload. Only resources whose content changed get a new update time.
    const now = this.now();
    const meta: RemoteMeta = { schemaVersion: 1, resources: { ...remoteSnapshot.meta.resources } };
    const files: Record<string, string> = {};
    const uploaded: string[] = [];
    const stage = (resource: string, path: string, content: string, localMtime?: number) => {
      const updatedAt = Math.max(localMtime ?? now.getTime(), remoteTime(resource));
      meta.resources[resource] = { updatedAt: new Date(updatedAt).toISOString(), updatedBy: this.deps.machine };
      files[path] = content;
      uploaded.push(resource);
    };

    const settingsChangedLocally = !jsonEquals(settings.merged, localSettings);
    const newSettingsText = settingsChangedLocally
      ? applySettingsChanges(settingsFile?.text ?? '', localSettings, settings.merged)
      : (settingsFile?.text ?? '{}');
    if (!jsonEquals(settings.merged, remoteView.settings ?? {})) {
      const ignoredKeys = Object.keys(allLocalSettings).filter(isIgnoredSetting);
      stage('settings', REMOTE_FILES.settings, removeSettings(newSettingsText, ignoredKeys), settingsFile?.mtime);
    }

    // Keybindings merge to one whole side, so an upload always carries the local file.
    const keybindingsChangedLocally = keybindings.merged !== localKeybindings;
    if (keybindings.merged !== (remoteView.keybindings ?? '[]')) {
      stage(keybindingsResource, REMOTE_FILES.keybindings(platform), keybindingsFile?.text ?? '[]\n', keybindingsFile?.mtime);
    }

    if (!jsonEquals(extensions, remoteView.extensions ?? [])) {
      stage('extensions', REMOTE_FILES.extensions, serializeExtensionList(extensions));
    }

    let commitSha = headSha;
    if (uploaded.length > 0) {
      files[REMOTE_FILES.meta] = serializeMeta(meta);
      const message = `sync: ${uploaded.join(', ')} from ${this.deps.machine} at ${now.toISOString()}`;
      commitSha = await remote.commit(headSha, files, message);
      logger.info(`Uploaded ${uploaded.join(', ')} (${commitSha.slice(0, 7)}).`);
    }

    // Apply locally.
    const applied: string[] = [];
    if (settingsChangedLocally) {
      await local.writeSettings(newSettingsText);
      applied.push('settings');
    }
    if (keybindingsChangedLocally) {
      if (remoteSnapshot.keybindingsText === undefined) {
        throw new Error(`Remote ${keybindingsResource} is missing although it was merged`);
      }
      await local.writeKeybindings(remoteSnapshot.keybindingsText);
      applied.push(keybindingsResource);
    }
    if (applied.length > 0) {
      logger.info(`Applied remote ${applied.join(', ')}.`);
    }

    const installedNow: string[] = [];
    let pendingUninstall: string[] = [];
    if (installedIds) {
      const installedSet = new Set(installedIds);
      for (const id of extensions) {
        if (installedSet.has(id) || isIgnoredExtension(id)) {
          continue;
        }
        try {
          await local.installExtension(id);
          installedNow.push(id);
          unavailable.delete(id);
          logger.info(`Installed extension ${id}.`);
        } catch (error) {
          unavailable.add(id);
          logger.warn(`Could not install extension ${id}: ${errorMessage(error)}`);
        }
      }
      const mergedSet = new Set(extensions);
      const removedRemotely = installedIds.filter((id) => !mergedSet.has(id) && !isExcluded(id));
      pendingUninstall = normalizeExtensionIds([...pending, ...removedRemotely]).filter((id) => installedSet.has(id));
    }

    // Pending removals are persisted, so a dismissed prompt never re-uploads extensions removed elsewhere.
    await this.deps.state.write({
      base: { commitSha, settings: settings.merged, keybindings: keybindings.merged, extensions, meta },
      localOnlyExtensions: localOnly,
      pendingUninstall,
      unavailableExtensions: [...unavailable].sort(),
    });

    const changed = uploaded.length + applied.length + installedNow.length > 0;
    return report(changed ? 'synced' : 'up-to-date', {
      commitSha,
      uploaded,
      applied,
      conflicts,
      installed: installedNow,
      pendingUninstall,
    });
  }

  private async readRemote(commitSha: string, isIgnoredSetting: (key: string) => boolean): Promise<RemoteSnapshot> {
    const { remote, local } = this.deps;
    const keybindingsPath = REMOTE_FILES.keybindings(local.platform);
    const [metaText, settingsText, keybindingsText, extensionsText] = await Promise.all([
      remote.readFile(commitSha, REMOTE_FILES.meta),
      remote.readFile(commitSha, REMOTE_FILES.settings),
      remote.readFile(commitSha, keybindingsPath),
      remote.readFile(commitSha, REMOTE_FILES.extensions),
    ]);
    return {
      meta: parseMeta(metaText),
      keybindingsText,
      view: {
        settings:
          settingsText === undefined
            ? undefined
            : omitKeys(parseSettings(settingsText, `remote ${REMOTE_FILES.settings}`), isIgnoredSetting),
        keybindings:
          keybindingsText === undefined ? undefined : canonicalKeybindings(keybindingsText, `remote ${keybindingsPath}`),
        extensions: extensionsText === undefined ? undefined : parseExtensionList(extensionsText),
      },
    };
  }
}

function snapshotFromBase(base: SyncBase): RemoteSnapshot {
  return {
    meta: base.meta,
    view: { settings: base.settings, keybindings: base.keybindings, extensions: base.extensions },
  };
}

function isEmptyView(view: SyncView): boolean {
  return view.settings === undefined && view.keybindings === undefined && view.extensions === undefined;
}

function report(outcome: SyncReport['outcome'], extra: Partial<SyncReport> = {}): SyncReport {
  return { outcome, uploaded: [], applied: [], conflicts: [], installed: [], pendingUninstall: [], ...extra };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
