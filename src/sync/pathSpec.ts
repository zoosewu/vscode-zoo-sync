import type { Platform } from './types';

/** Per-platform paths; `*` is the fallback for platforms without their own entry. */
export type PlatformPathMap = Partial<Record<Platform | '*', string>>;

export interface FileSpecObject {
  path: string | PlatformPathMap;
  /** Store one copy per platform instead of sharing a single copy. */
  perPlatform?: boolean;
}

export type FileSpec = string | FileSpecObject;

export type FileScope = 'home' | 'profile';

export interface ParsedFileSpec {
  /** Slash-separated path relative to the home directory or to a profile directory. */
  pattern: string;
  scope: FileScope;
  perPlatform: boolean;
}

/** Names that hold credentials often enough that syncing them is never worth the risk. */
const SENSITIVE_NAMES = [
  /^id_[a-z0-9]+$/i,
  /^.*\.(pem|key|p12|pfx|ppk)$/i,
  /^\.env(\..*)?$/i,
  /^credentials(\..*)?$/i,
  /^\.?netrc$/i,
  /^.*\.keystore$/i,
];

export function isSensitiveFileName(name: string): boolean {
  return SENSITIVE_NAMES.some((pattern) => pattern.test(name));
}

/**
 * Resolves one `zooSync.files` entry for a platform.
 * Returns `undefined` when the entry deliberately has no path on this platform.
 * Throws when the entry cannot be synced safely.
 */
export function parseFileSpec(spec: FileSpec, platform: Platform): ParsedFileSpec | undefined {
  const raw = typeof spec === 'string' ? spec : spec.path;
  const perPlatform = typeof spec === 'string' ? false : spec.perPlatform === true;
  const selected = typeof raw === 'string' ? raw : (raw?.[platform] ?? raw?.['*']);
  if (selected === undefined) {
    return undefined;
  }
  if (typeof selected !== 'string') {
    throw new Error(`Invalid path in zooSync.files: ${JSON.stringify(raw)}`);
  }

  let path = selected.replaceAll('\\', '/').trim();
  let scope: FileScope = 'profile';
  if (path === '~' || path.startsWith('~/')) {
    scope = 'home';
    path = path.slice(2);
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (path.endsWith('/**')) {
    // Already a recursive pattern.
  } else if (selected.endsWith('/')) {
    path = `${path}/**`;
  }

  if (path === '') {
    throw new Error(`Empty path in zooSync.files: ${JSON.stringify(selected)}`);
  }
  if (/^[A-Za-z]:/.test(path) || selected.startsWith('/') || selected.startsWith('\\\\')) {
    throw new Error(
      `Absolute paths are not supported: ${selected}. Use a path relative to the profile directory, or one starting with "~/".`,
    );
  }
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`Path must not contain "." or ".." segments: ${selected}`);
  }

  return { pattern: path, scope, perPlatform };
}

/**
 * Converts a path glob to a RegExp. `*` matches within one segment, `**` crosses segments,
 * and `a/**\/b` also matches `a/b`.
 */
export function globToPathRegExp(pattern: string, caseSensitive = true): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char !== '*') {
      source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      continue;
    }
    if (pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/' && source.endsWith('/')) {
        i++;
        source = `${source.slice(0, -1)}(?:/.*)?/`;
      } else {
        source += '.*';
      }
      continue;
    }
    source += '[^/]*';
  }
  return new RegExp(`^${source}$`, caseSensitive ? '' : 'i');
}

export function hasGlob(pattern: string): boolean {
  return pattern.includes('*');
}

/** File system paths are case-insensitive everywhere except Linux. */
export function isCaseSensitive(platform: Platform): boolean {
  return platform === 'linux';
}
