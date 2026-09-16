import { basename, join } from 'node:path';
import { canonicalize } from './canonical';
import {
  applySettingsChanges,
  canonicalKeybindings,
  normalizeExtensionIds,
  omitKeys,
  parseExtensionList,
  parseMeta,
  parseSettings,
  removeSettings,
  SCHEMA_VERSION,
  serializeExtensionList,
  serializeMeta,
} from './documents';
import { gitBlobSha } from './hash';
import { mapLegacyMetaKey, mapLegacyPath } from './legacy';
import { createExtensionFilter, createSettingFilter, looksLikeSecret } from './ignore';
import { mergeExtensions, mergeSettings, mergeValue, type ConflictWinner } from './merge';
import { isSensitiveFileName, type FileSpec } from './pathSpec';
import {
  emptyExtensionState,
  NonFastForwardError,
  type ExtensionState,
  type InitialSyncChoice,
  type LocalProfileInfo,
  type LocalState,
  type LocalStore,
  type Logger,
  type PendingDeletion,
  type RemoteStore,
  type StateStore,
} from './ports';
import { buildResourcePlan, relativeFromRemote, remotePathFor, type ResourcePlan } from './resources';
import type { BaseResource, JsonObject, RemoteMeta, SyncBase } from './types';

export const META_PATH = 'meta.json';
const MAX_ATTEMPTS = 3;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES_PER_PATTERN = 200;

export interface EngineConfig {
  profiles: readonly string[];
  files: readonly FileSpec[];
  ignoredSettings: readonly string[];
  ignoredExtensions: readonly string[];
  maxFileBytes?: number;
  maxFilesPerPattern?: number;
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
  localChanged: boolean;
  initialChoice?: InitialSyncChoice;
}

export interface SyncReport {
  outcome: 'up-to-date' | 'synced' | 'skipped' | 'needs-initial-choice';
  reason?: string;
  commitSha?: string;
  /** Remote paths written and removed. */
  uploaded: string[];
  removed: string[];
  /** Local paths written. */
  applied: string[];
  conflicts: string[];
  installed: string[];
  /** Installed here but removed elsewhere, for the current profile. */
  pendingUninstall: string[];
  /** Local paths deleted elsewhere, waiting for confirmation. */
  pendingDeletions: string[];
  /** Configured profiles that do not exist on this machine. */
  missingProfiles: string[];
  /** Profiles present in the repository but not configured here. */
  unconfiguredProfiles: string[];
  /** True when this run moved the repository to the current layout. */
  migrated: boolean;
  problems: string[];
}

type ResourceKind = 'settings' | 'keybindings' | 'file' | 'extensions';

interface SyncResource {
  remotePath: string;
  kind: ResourceKind;
  profile?: LocalProfileInfo;
  /** Absent for extensions, which come from VS Code's own manifests. */
  localPath?: string;
}

/** What one resource contributes to the sync, after merging. */
interface ResourceOutcome {
  canonical?: string;
  blobSha?: string;
  uploadText?: string;
  removeRemote?: boolean;
  applyText?: string;
  deleteLocal?: boolean;
  conflict?: boolean;
  localMtime?: number;
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

  /** Uninstalls the chosen extensions of a profile; the rest stay here without being synced. */
  async resolvePendingUninstall(profileName: string, chosen: readonly string[]): Promise<string[]> {
    const { local, logger } = this.deps;
    const state = await this.deps.state.read();
    const extensions = state.extensions[profileName] ?? emptyExtensionState();
    const uninstalled: string[] = [];
    const kept: string[] = [];
    for (const id of extensions.pendingUninstall) {
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
    state.extensions[profileName] = {
      ...extensions,
      localOnly: normalizeExtensionIds([...extensions.localOnly, ...kept]),
      pendingUninstall: [],
    };
    await this.deps.state.write(state);
    return uninstalled;
  }

  /** Deletes the chosen files; the rest stay here and stop being synced. */
  async resolvePendingDeletions(chosen: readonly string[]): Promise<string[]> {
    const { local, logger } = this.deps;
    const state = await this.deps.state.read();
    const deleted: string[] = [];
    const kept: string[] = [];
    for (const pending of state.pendingDeletions) {
      if (!chosen.includes(pending.localPath)) {
        kept.push(pending.remotePath);
        continue;
      }
      try {
        await local.deleteFile(pending.localPath);
        deleted.push(pending.localPath);
        logger.info(`Deleted ${pending.localPath}, which was removed on another machine.`);
      } catch (error) {
        kept.push(pending.remotePath);
        logger.warn(`Could not delete ${pending.localPath}: ${errorMessage(error)}`);
      }
    }
    state.localOnlyFiles = [...new Set([...state.localOnlyFiles, ...kept])].sort();
    state.pendingDeletions = [];
    await this.deps.state.write(state);
    return deleted;
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

    let head = headSha;
    let migrated = false;
    let tree: Map<string, string>;
    if (remoteChanged || !state.base) {
      tree = await remote.listTree(head);
      const migration = await this.migrate(head, tree);
      migrated = migration.head !== head;
      head = migration.head;
      tree = migration.tree;
    } else {
      tree = new Map(Object.entries(state.base.resources).map(([path, entry]) => [path, entry.blobSha]));
    }

    const plan = buildResourcePlan({ profiles: config.profiles, files: config.files }, local.platform);
    const problems = [...plan.problems];
    for (const problem of plan.problems) {
      logger.warn(problem);
    }
    const localProfiles = await local.listProfiles();
    const profilesByName = new Map(localProfiles.map((profile) => [profile.name, profile]));
    const missingProfiles = plan.profiles.filter((name) => !profilesByName.has(name));
    const unconfiguredProfiles = remoteProfileNames(tree).filter((name) => !plan.profiles.includes(name));

    const resources = await this.collectResources(plan, profilesByName, tree, state, problems);
    const localPaths = resources.flatMap((resource) => (resource.localPath ? [resource.localPath] : []));
    if (local.hasUnsavedChanges(localPaths)) {
      return report('skipped', { reason: 'a synced file has unsaved changes', commitSha: head });
    }

    let mode: InitialSyncChoice | 'normal' = 'normal';
    if (!state.base) {
      const remoteHasData = [...tree.keys()].some((path) => path.startsWith('profiles/') || path.startsWith('files/'));
      if (remoteHasData) {
        if (!options.initialChoice) {
          return report('needs-initial-choice', { commitSha: head, missingProfiles, unconfiguredProfiles, problems });
        }
        mode = options.initialChoice;
        logger.info(`First sync on this machine: ${mode}.`);
      }
    }

    // Download only what changed remotely; anything whose blob id still matches the base is already known.
    const meta = await this.readMeta(head, tree, state.base);
    const downloads = new Map<string, Promise<string | undefined>>();
    for (const resource of resources) {
      const blobSha = tree.get(resource.remotePath);
      if (blobSha !== undefined && state.base?.resources[resource.remotePath]?.blobSha !== blobSha) {
        downloads.set(resource.remotePath, remote.readFile(head, resource.remotePath));
      }
    }
    const downloaded = new Map<string, string | undefined>();
    await Promise.all(
      [...downloads].map(async ([path, promise]) => {
        downloaded.set(path, await promise);
      }),
    );

    const isIgnoredSetting = createSettingFilter(config.ignoredSettings);
    const isIgnoredExtension = createExtensionFilter(config.ignoredExtensions);
    const pendingPaths = new Set(state.pendingDeletions.map((pending) => pending.remotePath));
    const keptPaths = new Set(state.localOnlyFiles);
    const currentProfile = await local.currentProfile();

    const outcomes = new Map<string, ResourceOutcome>();
    const conflicts: string[] = [];
    const installed: string[] = [];
    const nextExtensionState: Record<string, ExtensionState> = { ...state.extensions };
    const pendingDeletions: PendingDeletion[] = [];
    const stillKept: string[] = [];

    for (const resource of resources) {
      const remoteBlob = tree.get(resource.remotePath);
      const baseEntry = state.base?.resources[resource.remotePath];
      const remoteCanonicalRaw =
        remoteBlob === undefined
          ? undefined
          : downloaded.has(resource.remotePath)
            ? downloaded.get(resource.remotePath)
            : undefined;
      const remoteRaw = remoteCanonicalRaw;
      let remoteCanonical: string | undefined;
      if (remoteBlob !== undefined) {
        remoteCanonical =
          remoteRaw !== undefined
            ? this.canonicalFor(resource, remoteRaw, isIgnoredSetting)
            : baseEntry?.canonical;
      }

      const mirrorsRemote = pendingPaths.has(resource.remotePath) || keptPaths.has(resource.remotePath);
      if (mirrorsRemote && remoteBlob !== undefined) {
        // The file came back on another machine, so this machine stops mirroring and takes it again.
        pendingPaths.delete(resource.remotePath);
        keptPaths.delete(resource.remotePath);
      }

      const outcome = await this.processResource(resource, {
        mode,
        meta,
        remoteBlob,
        remoteRaw,
        remoteCanonical,
        baseCanonical: baseEntry?.canonical,
        mirrorsRemote: pendingPaths.has(resource.remotePath) || keptPaths.has(resource.remotePath),
        isIgnoredSetting,
        isIgnoredExtension,
        currentProfile,
        extensionState: nextExtensionState,
        installed,
      });
      if (outcome.conflict) {
        conflicts.push(resource.remotePath);
      }
      if (outcome.deleteLocal && resource.localPath) {
        pendingDeletions.push({ remotePath: resource.remotePath, localPath: resource.localPath });
      }
      outcomes.set(resource.remotePath, outcome);
    }
    for (const path of keptPaths) {
      stillKept.push(path);
    }

    // Upload.
    const now = this.now();
    const nextMeta: RemoteMeta = { schemaVersion: SCHEMA_VERSION, resources: { ...meta.resources } };
    const files: Record<string, string> = {};
    const removals: string[] = [];
    for (const resource of resources) {
      const outcome = outcomes.get(resource.remotePath);
      if (!outcome) {
        continue;
      }
      if (outcome.uploadText !== undefined) {
        files[resource.remotePath] = outcome.uploadText;
        const updatedAt = Math.max(outcome.localMtime ?? now.getTime(), remoteTime(meta, resource.remotePath));
        nextMeta.resources[resource.remotePath] = {
          updatedAt: new Date(updatedAt).toISOString(),
          updatedBy: this.deps.machine,
        };
      } else if (outcome.removeRemote) {
        removals.push(resource.remotePath);
        delete nextMeta.resources[resource.remotePath];
      }
    }

    let commitSha = head;
    const uploaded = Object.keys(files);
    if (uploaded.length > 0 || removals.length > 0) {
      files[META_PATH] = serializeMeta(nextMeta);
      commitSha = await remote.commit(head, files, removals, this.commitMessage(uploaded, removals, now));
      logger.info(`Uploaded ${uploaded.length} file(s), removed ${removals.length} (${commitSha.slice(0, 7)}).`);
    }

    // Apply locally.
    const applied: string[] = [];
    for (const resource of resources) {
      const outcome = outcomes.get(resource.remotePath);
      if (!outcome || outcome.applyText === undefined || !resource.localPath) {
        continue;
      }
      await local.writeFile(resource.localPath, outcome.applyText);
      applied.push(resource.localPath);
    }
    if (applied.length > 0) {
      logger.info(`Applied ${applied.length} file(s) from the repository.`);
    }

    // Persist before any prompt, so a dismissed question never re-uploads what another machine removed.
    const baseResources: Record<string, BaseResource> = {};
    for (const resource of resources) {
      const outcome = outcomes.get(resource.remotePath);
      const existsRemotely =
        outcome?.uploadText !== undefined || (tree.get(resource.remotePath) !== undefined && !outcome?.removeRemote);
      if (!outcome || outcome.canonical === undefined || !existsRemotely) {
        continue;
      }
      baseResources[resource.remotePath] = {
        canonical: outcome.canonical,
        blobSha: outcome.blobSha ?? tree.get(resource.remotePath) ?? '',
      };
    }
    const base: SyncBase = { commitSha, resources: baseResources, meta: nextMeta };
    await this.deps.state.write({
      base,
      extensions: nextExtensionState,
      pendingDeletions,
      localOnlyFiles: stillKept.sort(),
    });

    const pendingUninstall = currentProfile ? (nextExtensionState[currentProfile]?.pendingUninstall ?? []) : [];
    const changed = migrated || uploaded.length + removals.length + applied.length + installed.length > 0;
    return report(changed ? 'synced' : 'up-to-date', {
      commitSha,
      uploaded,
      removed: removals,
      applied,
      conflicts,
      installed,
      pendingUninstall,
      pendingDeletions: pendingDeletions.map((pending) => pending.localPath),
      missingProfiles,
      unconfiguredProfiles,
      problems,
    });
  }

  private async collectResources(
    plan: ResourcePlan,
    profilesByName: Map<string, LocalProfileInfo>,
    tree: Map<string, string>,
    state: LocalState,
    problems: string[],
  ): Promise<SyncResource[]> {
    const { local, logger, config } = this.deps;
    const maxFiles = config.maxFilesPerPattern ?? DEFAULT_MAX_FILES_PER_PATTERN;
    const resources = new Map<string, SyncResource>();

    for (const builtin of plan.builtins) {
      const profile = profilesByName.get(builtin.profile);
      if (!profile || (!profile.isDefault && usesDefaultProfileFor(profile, builtin.kind))) {
        continue;
      }
      resources.set(builtin.remotePath, {
        remotePath: builtin.remotePath,
        kind: builtin.kind,
        profile,
        localPath: builtin.relativePath ? join(profile.dir, builtin.relativePath) : undefined,
      });
    }

    const basePaths = Object.keys(state.base?.resources ?? {});
    for (const pattern of plan.patterns) {
      const profile = pattern.profile === undefined ? undefined : profilesByName.get(pattern.profile);
      const baseDir = pattern.scope === 'home' ? local.homeDir : profile?.dir;
      if (baseDir === undefined) {
        continue;
      }
      // A file counts when it exists here, in the repository, or in the last sync (so deletions travel).
      const relatives = new Set(await local.listFiles(baseDir, pattern.matches, maxFiles));
      for (const path of [...tree.keys(), ...basePaths]) {
        const relative = relativeFromRemote(pattern, path);
        if (relative !== undefined && pattern.matches(relative)) {
          relatives.add(relative);
        }
      }
      for (const relative of relatives) {
        if (isSensitiveFileName(basename(relative))) {
          const message = `Not syncing ${relative}: the name suggests it holds credentials.`;
          if (!problems.includes(message)) {
            problems.push(message);
            logger.warn(message);
          }
          continue;
        }
        const remotePath = remotePathFor(pattern, relative);
        if (!resources.has(remotePath)) {
          resources.set(remotePath, { remotePath, kind: 'file', profile, localPath: join(baseDir, relative) });
        }
      }
    }
    return [...resources.values()];
  }

  private async processResource(resource: SyncResource, context: ProcessContext): Promise<ResourceOutcome> {
    switch (resource.kind) {
      case 'settings':
        return this.processSettings(resource, context);
      case 'extensions':
        return this.processExtensions(resource, context);
      default:
        return this.processDocument(resource, context);
    }
  }

  private async processSettings(resource: SyncResource, context: ProcessContext): Promise<ResourceOutcome> {
    const file = resource.localPath ? await this.deps.local.readFile(resource.localPath) : undefined;
    const label = resource.localPath ?? resource.remotePath;
    const allLocal = parseSettings(file?.text, label);
    const secrets = Object.keys(allLocal).filter(looksLikeSecret);
    if (secrets.length > 0) {
      this.deps.logger.info(`Not syncing secret-like settings in ${label}: ${secrets.join(', ')}`);
    }
    const localObject = omitKeys(allLocal, context.isIgnoredSetting);
    const localCanonical = canonicalize(localObject);
    const remoteObject =
      context.remoteCanonical === undefined ? undefined : (JSON.parse(context.remoteCanonical) as JsonObject);
    const baseCanonical = this.baseFor(context, localCanonical);
    const baseObject = baseCanonical === undefined ? undefined : (JSON.parse(baseCanonical) as JsonObject);
    const winner = this.winnerFor(context, resource.remotePath, file?.mtime);
    const { merged, conflicts } = mergeSettings(baseObject, localObject, remoteObject, winner);
    const mergedCanonical = canonicalize(merged);
    for (const key of conflicts) {
      this.deps.logger.warn(`Conflict on setting "${key}" in ${label}: kept the ${winner} value (newer update time).`);
    }

    const outcome: ResourceOutcome = {
      canonical: mergedCanonical,
      conflict: conflicts.length > 0,
      localMtime: file?.mtime,
    };
    if (mergedCanonical !== localCanonical) {
      outcome.applyText = applySettingsChanges(file?.text ?? '', localObject, merged);
    }
    if (mergedCanonical !== (context.remoteCanonical ?? canonicalize({}))) {
      const ignoredKeys = Object.keys(allLocal).filter(context.isIgnoredSetting);
      outcome.uploadText = removeSettings(outcome.applyText ?? file?.text ?? '{}', ignoredKeys);
      outcome.blobSha = gitBlobSha(outcome.uploadText);
    }
    return outcome;
  }

  private async processDocument(resource: SyncResource, context: ProcessContext): Promise<ResourceOutcome> {
    const file = resource.localPath ? await this.deps.local.readFile(resource.localPath) : undefined;
    if (file && resource.kind === 'file' && !this.isSyncableFile(file.text, resource)) {
      // Leave both sides untouched rather than uploading or deleting something we cannot handle.
      return { canonical: context.remoteCanonical, blobSha: context.remoteBlob };
    }
    const localCanonical = context.mirrorsRemote
      ? context.remoteCanonical
      : file === undefined
        ? undefined
        : this.canonicalFor(resource, file.text, context.isIgnoredSetting);
    const baseCanonical = this.baseFor(context, localCanonical);
    const winner = this.winnerFor(context, resource.remotePath, file?.mtime);
    const { value: merged, conflict } = mergeValue(baseCanonical, localCanonical, context.remoteCanonical, winner);
    if (conflict) {
      this.deps.logger.warn(`Conflict on ${resource.remotePath}: kept the ${winner} version (newer update time).`);
    }

    const outcome: ResourceOutcome = { canonical: merged, conflict, localMtime: file?.mtime };
    if (merged !== localCanonical && !context.mirrorsRemote) {
      if (merged === undefined) {
        outcome.deleteLocal = file !== undefined;
      } else if (context.remoteRaw !== undefined) {
        outcome.applyText = context.remoteRaw;
      } else {
        throw new Error(`Remote ${resource.remotePath} is missing although it was merged`);
      }
    }
    if (merged !== context.remoteCanonical) {
      if (merged === undefined) {
        outcome.removeRemote = context.remoteBlob !== undefined;
      } else if (file !== undefined) {
        outcome.uploadText = file.text;
        outcome.blobSha = gitBlobSha(file.text);
      }
    }
    return outcome;
  }

  private async processExtensions(resource: SyncResource, context: ProcessContext): Promise<ResourceOutcome> {
    const { local, logger } = this.deps;
    const profile = resource.profile;
    if (!profile) {
      return {};
    }
    const previous = context.extensionState[profile.name] ?? emptyExtensionState();
    const installedIds = await local.listExtensions(profile);
    const remoteIds =
      context.remoteCanonical === undefined ? undefined : (JSON.parse(context.remoteCanonical) as string[]);
    const reference = remoteIds ?? [];
    const localOnly = previous.localOnly.filter((id) => !reference.includes(id));
    const pending = previous.pendingUninstall.filter((id) => !reference.includes(id));
    const unavailable = new Set(previous.unavailable.filter((id) => reference.includes(id)));
    const isExcluded = (id: string) =>
      context.isIgnoredExtension(id) || localOnly.includes(id) || pending.includes(id) || unavailable.has(id);

    // Extensions this machine does not manage mirror the repository, so they never look changed here.
    const installedSet = installedIds ? new Set(normalizeExtensionIds(installedIds)) : undefined;
    const localIds = installedSet
      ? normalizeExtensionIds([...[...installedSet].filter((id) => !isExcluded(id)), ...reference.filter(isExcluded)])
      : reference;
    const localCanonical = canonicalize(localIds);
    const baseCanonical = this.baseFor(context, localCanonical);
    const baseIds = baseCanonical === undefined ? undefined : (JSON.parse(baseCanonical) as string[]);
    const merged = mergeExtensions(baseIds, localIds, remoteIds);
    const mergedCanonical = canonicalize(merged);

    const outcome: ResourceOutcome = { canonical: mergedCanonical };
    if (mergedCanonical !== (context.remoteCanonical ?? canonicalize([]))) {
      outcome.uploadText = serializeExtensionList(merged);
      outcome.blobSha = gitBlobSha(outcome.uploadText);
    }

    let pendingUninstall = pending;
    const canApply = installedSet !== undefined && local.canManageExtensions() && context.currentProfile === profile.name;
    if (canApply && installedSet) {
      for (const id of merged) {
        if (installedSet.has(id) || context.isIgnoredExtension(id)) {
          continue;
        }
        try {
          await local.installExtension(id);
          context.installed.push(id);
          unavailable.delete(id);
          logger.info(`Installed extension ${id} in profile ${profile.name}.`);
        } catch (error) {
          unavailable.add(id);
          logger.warn(`Could not install extension ${id}: ${errorMessage(error)}`);
        }
      }
      const mergedSet = new Set(merged);
      const removedRemotely = [...installedSet].filter((id) => !mergedSet.has(id) && !isExcluded(id));
      pendingUninstall = normalizeExtensionIds([...pending, ...removedRemotely]).filter((id) => installedSet.has(id));
    }
    context.extensionState[profile.name] = { localOnly, pendingUninstall, unavailable: [...unavailable].sort() };
    return outcome;
  }

  /** Moves a schema 1 repository (flat, Default profile only) to the schema 2 layout in one commit. */
  private async migrate(head: string, tree: Map<string, string>): Promise<{ head: string; tree: Map<string, string> }> {
    const { remote, logger } = this.deps;
    if (!tree.has(META_PATH)) {
      return { head, tree };
    }
    const meta = parseMeta(await remote.readFile(head, META_PATH));
    if (meta.schemaVersion !== 1) {
      return { head, tree };
    }
    const files: Record<string, string> = {};
    const deletions: string[] = [];
    const next = new Map(tree);
    for (const path of tree.keys()) {
      const mapped = mapLegacyPath(path);
      if (!mapped) {
        continue;
      }
      const text = await remote.readFile(head, path);
      if (text === undefined) {
        continue;
      }
      files[mapped] = text;
      deletions.push(path);
      next.delete(path);
      next.set(mapped, gitBlobSha(text));
    }
    const resources: RemoteMeta['resources'] = {};
    for (const [key, value] of Object.entries(meta.resources)) {
      const mapped = mapLegacyMetaKey(key);
      if (mapped) {
        resources[mapped] = value;
      }
    }
    files[META_PATH] = serializeMeta({ schemaVersion: SCHEMA_VERSION, resources });
    next.set(META_PATH, gitBlobSha(files[META_PATH]));
    const migratedHead = await remote.commit(
      head,
      files,
      deletions,
      'chore: move Zoo Sync data into the profile layout',
    );
    logger.info('Moved the repository to the profile layout (schema 2).');
    return { head: migratedHead, tree: next };
  }

  private baseFor(context: ProcessContext, localCanonical: string | undefined): string | undefined {
    switch (context.mode) {
      case 'download':
        return localCanonical; // this machine looks unchanged, so the repository wins
      case 'upload':
        return context.remoteCanonical; // the repository looks unchanged, so this machine wins
      case 'merge':
        return undefined; // no common ancestor: differences are conflicts, and the repository wins those
      default:
        return context.baseCanonical;
    }
  }

  private winnerFor(context: ProcessContext, remotePath: string, localMtime: number | undefined): ConflictWinner {
    if (context.mode !== 'normal') {
      return 'remote';
    }
    return (localMtime ?? 0) > remoteTime(context.meta, remotePath) ? 'local' : 'remote';
  }

  private isSyncableFile(text: string, resource: SyncResource): boolean {
    const limit = this.deps.config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (Buffer.byteLength(text, 'utf8') > limit) {
      this.deps.logger.warn(`Not syncing ${resource.localPath ?? resource.remotePath}: larger than ${limit} bytes.`);
      return false;
    }
    if (text.includes('\u0000')) {
      this.deps.logger.warn(`Not syncing ${resource.localPath ?? resource.remotePath}: it is not a text file.`);
      return false;
    }
    return true;
  }

  private commitMessage(uploaded: readonly string[], removed: readonly string[], now: Date): string {
    const parts = [...uploaded.map((path) => path), ...removed.map((path) => `-${path}`)];
    const shown = parts.slice(0, 3).join(', ');
    const rest = parts.length > 3 ? `, +${parts.length - 3} more` : '';
    return `sync: ${shown}${rest} from ${this.deps.machine} at ${now.toISOString()}`;
  }

  private canonicalFor(resource: SyncResource, raw: string, isIgnoredSetting: (key: string) => boolean): string {
    switch (resource.kind) {
      case 'settings':
        return canonicalize(omitKeys(parseSettings(raw, resource.remotePath), isIgnoredSetting));
      case 'keybindings':
        return canonicalKeybindings(raw, resource.remotePath);
      case 'extensions':
        return canonicalize(parseExtensionList(raw));
      default:
        return raw;
    }
  }

  private async readMeta(head: string, tree: Map<string, string>, base: SyncBase | undefined): Promise<RemoteMeta> {
    const blobSha = tree.get(META_PATH);
    if (blobSha === undefined) {
      return { schemaVersion: SCHEMA_VERSION, resources: {} };
    }
    if (base && base.meta && gitBlobSha(serializeMeta(base.meta)) === blobSha) {
      return base.meta;
    }
    return parseMeta(await this.deps.remote.readFile(head, META_PATH));
  }
}

interface ProcessContext {
  mode: InitialSyncChoice | 'normal';
  meta: RemoteMeta;
  remoteBlob?: string;
  remoteRaw?: string;
  remoteCanonical?: string;
  baseCanonical?: string;
  mirrorsRemote: boolean;
  isIgnoredSetting: (key: string) => boolean;
  isIgnoredExtension: (id: string) => boolean;
  currentProfile?: string;
  extensionState: Record<string, ExtensionState>;
  installed: string[];
}

function usesDefaultProfileFor(profile: LocalProfileInfo, kind: ResourceKind): boolean {
  const flags = profile.useDefaultFlags;
  switch (kind) {
    case 'settings':
      return flags?.settings === true;
    case 'keybindings':
      return flags?.keybindings === true;
    case 'extensions':
      return flags?.extensions === true;
    default:
      return false;
  }
}

function remoteTime(meta: RemoteMeta, path: string): number {
  return Date.parse(meta.resources[path]?.updatedAt ?? '') || 0;
}

function remoteProfileNames(tree: Map<string, string>): string[] {
  const names = new Set<string>();
  for (const path of tree.keys()) {
    const match = /^profiles\/([^/]+)\//.exec(path);
    if (match) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

function report(outcome: SyncReport['outcome'], extra: Partial<SyncReport> = {}): SyncReport {
  return {
    outcome,
    uploaded: [],
    removed: [],
    applied: [],
    conflicts: [],
    installed: [],
    pendingUninstall: [],
    pendingDeletions: [],
    missingProfiles: [],
    unconfiguredProfiles: [],
    migrated: false,
    problems: [],
    ...extra,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
