import { describe, expect, it } from 'vitest';
import { gitBlobSha } from '../../src/sync/hash';
import { globToPathRegExp, isSensitiveFileName, parseFileSpec } from '../../src/sync/pathSpec';

describe('parseFileSpec', () => {
  it('treats a plain relative path as profile-scoped', () => {
    expect(parseFileSpec('snippets/**', 'linux')).toEqual({ pattern: 'snippets/**', scope: 'profile', perPlatform: false });
  });

  it('treats a ~ path as home-scoped and strips the prefix', () => {
    expect(parseFileSpec('~/.gitconfig', 'linux')).toEqual({ pattern: '.gitconfig', scope: 'home', perPlatform: false });
  });

  it('turns a trailing slash into a recursive pattern', () => {
    expect(parseFileSpec('snippets/', 'linux')?.pattern).toBe('snippets/**');
  });

  it('accepts backslashes and per-platform maps', () => {
    const spec = { path: { windows: '~\\AppData\\Roaming\\x.toml', '*': '~/.config/x.toml' }, perPlatform: true };
    expect(parseFileSpec(spec, 'windows')).toEqual({ pattern: 'AppData/Roaming/x.toml', scope: 'home', perPlatform: true });
    expect(parseFileSpec(spec, 'macos')?.pattern).toBe('.config/x.toml');
  });

  it('skips entries that have no path for this platform', () => {
    expect(parseFileSpec({ path: { windows: '~/x' } }, 'linux')).toBeUndefined();
  });

  it.each(['/etc/hosts', 'C:/Users/me/x.toml', '\\\\server\\share\\x', '../outside', 'snippets/../../x'])(
    'rejects %s',
    (path) => {
      expect(() => parseFileSpec(path, 'linux')).toThrow();
    },
  );
});

describe('globToPathRegExp', () => {
  const matches = (pattern: string, path: string) => globToPathRegExp(pattern).test(path);

  it('keeps * inside one segment and lets ** cross segments', () => {
    expect(matches('snippets/*.json', 'snippets/py.json')).toBe(true);
    expect(matches('snippets/*.json', 'snippets/lang/py.json')).toBe(false);
    expect(matches('snippets/**', 'snippets/lang/py.json')).toBe(true);
  });

  it('lets a/**/b match a/b', () => {
    expect(matches('a/**/b.json', 'a/b.json')).toBe(true);
    expect(matches('a/**/b.json', 'a/x/y/b.json')).toBe(true);
  });

  it('escapes regex characters and can ignore case', () => {
    expect(matches('a+b.json', 'a+b.json')).toBe(true);
    expect(matches('a+b.json', 'axb.json')).toBe(false);
    expect(globToPathRegExp('Snippets/**', false).test('snippets/a.json')).toBe(true);
  });
});

describe('isSensitiveFileName', () => {
  it.each(['id_rsa', 'server.pem', '.env', '.env.local', 'credentials.json', 'my.keystore'])('flags %s', (name) => {
    expect(isSensitiveFileName(name)).toBe(true);
  });

  it.each(['settings.json', 'keybindings.json', 'starship.toml', 'environment.md'])('allows %s', (name) => {
    expect(isSensitiveFileName(name)).toBe(false);
  });
});

describe('gitBlobSha', () => {
  it('matches git hash-object for a known input', () => {
    // printf 'hello\n' | git hash-object --stdin
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});
