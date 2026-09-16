import { join } from 'node:path';

/** Resources a profile deliberately shares with the Default profile instead of keeping its own copy. */
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

export interface LocalProfile {
  id: string;
  name: string;
  /** absolute path, POSIX or native separators as given by userDir */
  dir: string;
  isDefault: boolean;
  useDefaultFlags?: UseDefaultFlags;
}

export const DEFAULT_PROFILE_NAME = 'Default';
export const DEFAULT_PROFILE_ID = '__default__profile__';

const USE_DEFAULT_FLAG_KEYS = [
  'settings',
  'keybindings',
  'tasks',
  'snippets',
  'prompts',
  'mcp',
  'extensions',
  'globalState',
] as const;

/**
 * Profiles recorded in `User/globalStorage/storage.json`, Default first.
 * The file belongs to VS Code and its shape is undocumented, so every field is treated as untrusted:
 * anything unparseable degrades to "only the Default profile exists".
 */
export function parseProfiles(storageJson: string | undefined, userDir: string): LocalProfile[] {
  const profiles: LocalProfile[] = [
    { id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME, dir: userDir, isDefault: true },
  ];
  const seenNames = new Set([DEFAULT_PROFILE_NAME]);
  const seenIds = new Set([DEFAULT_PROFILE_ID]);

  for (const entry of asArray(readKey(storageJson, 'userDataProfiles'))) {
    const record = asRecord(entry);
    const name = typeof record?.name === 'string' ? record.name.trim() : '';
    const id = lastSegment(locationPath(record?.location));
    if (!name || !id || seenNames.has(name) || seenIds.has(id)) {
      continue;
    }
    seenNames.add(name);
    seenIds.add(id);
    profiles.push({
      id,
      name,
      dir: join(userDir, 'profiles', id),
      isDefault: false,
      useDefaultFlags: parseUseDefaultFlags(record?.useDefaultFlags),
    });
  }
  return profiles;
}

/**
 * Name of the profile a window with `workspaceUri` open is using.
 * `undefined` means it cannot be determined: an empty window (whose id is not visible to extensions),
 * or an association pointing at a profile that no longer exists.
 */
export function findProfileForWorkspace(
  storageJson: string | undefined,
  workspaceUri: string | undefined,
  userDir: string,
): string | undefined {
  if (!workspaceUri) {
    return undefined;
  }
  const associations = asRecord(readKey(storageJson, 'profileAssociations'));
  const workspaces = asRecord(associations?.workspaces);
  if (!workspaces) {
    return DEFAULT_PROFILE_NAME;
  }

  const wanted = withoutTrailingSlash(workspaceUri);
  let profileId: string | undefined;
  for (const [key, value] of Object.entries(workspaces)) {
    if (withoutTrailingSlash(key) === wanted && typeof value === 'string') {
      profileId = value;
      break;
    }
  }
  if (profileId === undefined) {
    // Workspaces are only listed once they are moved off the Default profile.
    return DEFAULT_PROFILE_NAME;
  }
  return parseProfiles(storageJson, userDir).find((profile) => profile.id === profileId)?.name;
}

function readKey(storageJson: string | undefined, key: string): unknown {
  if (storageJson === undefined) {
    return undefined;
  }
  const root = asRecord(parseJson(storageJson));
  const value = root?.[key];
  // Some VS Code versions store these values as embedded JSON strings.
  return typeof value === 'string' ? parseJson(value) : value;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `location` is a path, a URI string, or UriComponents. */
function locationPath(location: unknown): string {
  if (typeof location === 'string') {
    return location;
  }
  const record = asRecord(location);
  for (const key of ['fsPath', 'path', 'external']) {
    const value = record?.[key];
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return '';
}

/** Last path segment, tolerating both separators, trailing separators and URI query or fragment parts. */
function lastSegment(location: string): string {
  const withoutSuffix = location.split(/[?#]/, 1)[0];
  const segments = withoutSuffix.split(/[\\/]/).filter((segment) => segment !== '');
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

function parseUseDefaultFlags(value: unknown): UseDefaultFlags | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const flags: UseDefaultFlags = {};
  for (const key of USE_DEFAULT_FLAG_KEYS) {
    if (record[key] === true) {
      flags[key] = true;
    }
  }
  return Object.keys(flags).length > 0 ? flags : undefined;
}
