import { globToRegExp } from './ignore';

/** VS Code Stable, Insiders and anything else on the Microsoft marketplace count as one app. */
export const DEFAULT_APP_ID = 'code';

/**
 * Identifies the editor this window belongs to. Forks keep VS Code's layout but have their own
 * marketplace and settings, so synced data is shared or separated by this id.
 */
export function detectAppId(uriScheme: string | undefined, override?: string): string {
  const explicit = sanitizeAppId(override ?? '');
  if (explicit) {
    return explicit;
  }
  const scheme = sanitizeAppId(uriScheme ?? '');
  if (!scheme) {
    return DEFAULT_APP_ID;
  }
  return scheme.startsWith('vscode') ? DEFAULT_APP_ID : scheme;
}

export function sanitizeAppId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

/** Where a setting key belongs: this app's own file, the shared file, or another app's file. */
export type SettingScope = 'mine' | 'shared' | 'foreign';

/**
 * Keys such as `cursor.*` mean nothing in another editor, so each app keeps its own file and
 * leaves the other app's keys alone instead of copying them around.
 */
export function createSettingClassifier(
  appSettings: Readonly<Record<string, readonly string[]>>,
  appId: string,
): (key: string) => SettingScope {
  const mine: RegExp[] = [];
  const others: RegExp[] = [];
  for (const [app, patterns] of Object.entries(appSettings ?? {})) {
    const target = sanitizeAppId(app) === appId ? mine : others;
    for (const pattern of patterns ?? []) {
      target.push(globToRegExp(pattern));
    }
  }
  return (key) => {
    if (mine.some((regexp) => regexp.test(key))) {
      return 'mine';
    }
    return others.some((regexp) => regexp.test(key)) ? 'foreign' : 'shared';
  };
}
