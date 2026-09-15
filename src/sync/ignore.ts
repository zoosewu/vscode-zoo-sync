const SECRET_SUFFIX = /(api[-_]?key|access[-_]?token|auth[-_]?token|password|secret)$/i;

/** True when the last segment of a setting key looks like it holds a credential. */
export function looksLikeSecret(key: string): boolean {
  return SECRET_SUFFIX.test(key.slice(key.lastIndexOf('.') + 1));
}

/** `*` matches any run of characters, including `.`; everything else is literal. */
export function globToRegExp(pattern: string, flags = ''): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, flags);
}

/** Predicate that is true for setting keys which must not be synced. */
export function createSettingFilter(patterns: readonly string[]): (key: string) => boolean {
  const regexps = patterns.map((p) => globToRegExp(p));
  return (key) => looksLikeSecret(key) || regexps.some((r) => r.test(key));
}

/** Predicate that is true for extension ids which must not be synced. Case-insensitive. */
export function createExtensionFilter(patterns: readonly string[]): (id: string) => boolean {
  const regexps = patterns.map((p) => globToRegExp(p, 'i'));
  return (id) => regexps.some((r) => r.test(id));
}
