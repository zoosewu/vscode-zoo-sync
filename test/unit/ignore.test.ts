import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExtensionFilter, createSettingFilter, globToRegExp, looksLikeSecret } from '../../src/sync/ignore';

const manifest = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
const defaultIgnoredSettings: string[] =
  manifest.contributes.configuration.properties['zooSync.ignoredSettings'].default;

describe('globToRegExp', () => {
  it('matches * across dots and escapes regex characters', () => {
    expect(globToRegExp('*.path').test('a.b.path')).toBe(true);
    expect(globToRegExp('[python]').test('[python]')).toBe(true);
    expect(globToRegExp('a.b').test('aXb')).toBe(false);
  });
});

describe('default ignored settings', () => {
  const isIgnored = createSettingFilter(defaultIgnoredSettings);

  it.each([
    'zooSync.autoSync',
    'http.proxy',
    'http.proxyStrictSSL',
    'git.path',
    'python.defaultInterpreterPath',
    'terminal.integrated.cwd',
    'window.zoomLevel',
    'someExt.lastCheckTime',
    'someExt.machineId',
  ])('ignores %s', (key) => {
    expect(isIgnored(key)).toBe(true);
  });

  it.each(['editor.fontSize', 'zooSync.repository', 'workbench.colorTheme', '[python]', 'files.exclude'])(
    'syncs %s',
    (key) => {
      expect(isIgnored(key)).toBe(false);
    },
  );
});

describe('looksLikeSecret', () => {
  it.each(['openai.apiKey', 'foo.api_key', 'ext.accessToken', 'db.password', 'svc.clientSecret'])('flags %s', (key) => {
    expect(looksLikeSecret(key)).toBe(true);
  });

  it.each(['editor.tokenColorCustomizations', 'workbench.secretStorage', 'editor.semanticHighlighting.enabled'])(
    'does not flag %s',
    (key) => {
      expect(looksLikeSecret(key)).toBe(false);
    },
  );
});

describe('createExtensionFilter', () => {
  it('is case-insensitive', () => {
    const isIgnored = createExtensionFilter(['MS-Python.*']);
    expect(isIgnored('ms-python.python')).toBe(true);
    expect(isIgnored('esbenp.prettier-vscode')).toBe(false);
  });
});
