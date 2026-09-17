/** Mapping from the schema 1 layout (flat, Default profile only) to schema 2 paths. */
const LEGACY_KEYBINDINGS = /^keybindings\/(windows|macos|linux)\.json$/;
const LEGACY_META_KEYBINDINGS = /^keybindings\.(windows|macos|linux)$/;

export const LEGACY_PROFILE_DIR = 'profiles/Default';

export function mapLegacyPath(path: string): string | undefined {
  if (path === 'settings.json' || path === 'extensions.json') {
    return `${LEGACY_PROFILE_DIR}/${path}`;
  }
  const match = LEGACY_KEYBINDINGS.exec(path);
  return match ? `${LEGACY_PROFILE_DIR}/keybindings/${match[1]}.json` : undefined;
}

export function mapLegacyMetaKey(key: string): string | undefined {
  if (key === 'settings' || key === 'extensions') {
    return `${LEGACY_PROFILE_DIR}/${key}.json`;
  }
  const match = LEGACY_META_KEYBINDINGS.exec(key);
  return match ? `${LEGACY_PROFILE_DIR}/keybindings/${match[1]}.json` : undefined;
}

/** Schema 2 kept one extension list per profile; schema 3 keeps one per editor. */
const SCHEMA2_EXTENSIONS = /^(profiles\/[^/]+)\/extensions\.json$/;

export function mapSchema2Path(path: string, appId: string): string | undefined {
  const match = SCHEMA2_EXTENSIONS.exec(path);
  return match ? `${match[1]}/extensions.${appId}.json` : undefined;
}
