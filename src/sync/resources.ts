import { globToPathRegExp, isCaseSensitive, parseFileSpec, type FileScope, type FileSpec } from './pathSpec';
import type { Platform } from './types';

export const DEFAULT_PROFILE = 'Default';

export type ResourceKind = 'settings' | 'keybindings' | 'extensions' | 'file';

export interface BuiltinResource {
  kind: 'settings' | 'keybindings' | 'extensions';
  profile: string;
  remotePath: string;
  /** Path inside the profile directory. Extensions come from the editor's own manifests instead. */
  relativePath?: string;
  /** Settings only: the shared file, or the file holding this app's own keys. */
  bucket?: 'shared' | 'app';
}

export interface FilePattern {
  scope: FileScope;
  /** Set for profile-scoped patterns only. */
  profile?: string;
  pattern: string;
  perPlatform: boolean;
  /** Remote directory holding the files this pattern matches. */
  remotePrefix: string;
  matches(relativePath: string): boolean;
}

export interface ResourcePlan {
  profiles: string[];
  builtins: BuiltinResource[];
  patterns: FilePattern[];
  /** Configuration entries that were rejected, ready to be logged. */
  problems: string[];
}

export function profileRemoteDir(profile: string): string {
  return `profiles/${profile}`;
}

/** Remote path of a file matched by `pattern`. */
export function remotePathFor(pattern: FilePattern, relativePath: string): string {
  return `${pattern.remotePrefix}/${relativePath}`;
}

/** The path relative to the pattern's directory, or `undefined` when the remote path is elsewhere. */
export function relativeFromRemote(pattern: FilePattern, remotePath: string): string | undefined {
  const prefix = `${pattern.remotePrefix}/`;
  return remotePath.startsWith(prefix) ? remotePath.slice(prefix.length) : undefined;
}

/** Expands the configuration into everything that is synced for this platform. */
export function buildResourcePlan(
  config: { profiles: readonly string[]; files: readonly FileSpec[]; appId: string },
  platform: Platform,
): ResourcePlan {
  const problems: string[] = [];
  const profiles = normalizeProfiles(config.profiles, problems);

  // Settings and keybindings are shared between editors; extensions are not, because Cursor and
  // VS Code use different marketplaces where the same id can point at different code.
  const app = config.appId;
  const builtins: BuiltinResource[] = [];
  for (const profile of profiles) {
    const dir = profileRemoteDir(profile);
    builtins.push({
      kind: 'settings',
      profile,
      remotePath: `${dir}/settings.json`,
      relativePath: 'settings.json',
      bucket: 'shared',
    });
    builtins.push({
      kind: 'settings',
      profile,
      remotePath: `${dir}/settings.${app}.json`,
      relativePath: 'settings.json',
      bucket: 'app',
    });
    builtins.push({
      kind: 'keybindings',
      profile,
      remotePath: `${dir}/keybindings/${platform}.json`,
      relativePath: 'keybindings.json',
    });
    builtins.push({ kind: 'extensions', profile, remotePath: `${dir}/extensions.${app}.json` });
  }

  const caseSensitive = isCaseSensitive(platform);
  const patterns: FilePattern[] = [];
  for (const spec of config.files) {
    let parsed;
    try {
      parsed = parseFileSpec(spec, platform);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!parsed) {
      continue;
    }
    const folder = parsed.perPlatform ? platform : 'common';
    const regexp = globToPathRegExp(parsed.pattern, caseSensitive);
    const matches = (relativePath: string) => regexp.test(relativePath);
    if (parsed.scope === 'home') {
      patterns.push({ ...parsed, remotePrefix: `files/${folder}`, matches });
    } else {
      for (const profile of profiles) {
        patterns.push({ ...parsed, profile, remotePrefix: `${profileRemoteDir(profile)}/files/${folder}`, matches });
      }
    }
  }

  return { profiles, builtins, patterns, problems };
}

function normalizeProfiles(names: readonly string[], problems: string[]): string[] {
  const result: string[] = [];
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name === '' || name === '.' || name === '..' || /[/\\:*?"<>|]/.test(name)) {
      problems.push(`Invalid profile name in zooSync.profiles: ${JSON.stringify(raw)}`);
      continue;
    }
    if (!result.includes(name)) {
      result.push(name);
    }
  }
  return result.length > 0 ? result : [DEFAULT_PROFILE];
}
