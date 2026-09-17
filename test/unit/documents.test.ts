import { describe, expect, it } from 'vitest';
import {
  applySettingsChanges,
  canonicalKeybindings,
  normalizeExtensionIds,
  omitKeys,
  parseExtensionList,
  parseMeta,
  parseSettings,
  removeSettings,
} from '../../src/sync/documents';

describe('parseSettings', () => {
  it('returns an empty object for missing or blank files', () => {
    expect(parseSettings(undefined)).toEqual({});
    expect(parseSettings('')).toEqual({});
  });

  it('rejects non-object documents', () => {
    expect(() => parseSettings('[]')).toThrow(/JSON object/);
  });
});

describe('omitKeys', () => {
  it('drops keys matching the predicate', () => {
    expect(omitKeys({ a: 1, b: 2 }, (k) => k === 'a')).toEqual({ b: 2 });
  });
});

describe('applySettingsChanges', () => {
  const text = [
    '// my settings',
    '{',
    '    "editor.fontSize": 14, // big',
    '    "git.path": "/usr/bin/git",',
    '    "files.autoSave": "off"',
    '}',
  ].join('\n');

  it('changes, adds and removes only differing keys while keeping comments and ignored keys', () => {
    const from = { 'editor.fontSize': 14, 'files.autoSave': 'off' };
    const to = { 'editor.fontSize': 16, 'editor.tabSize': 2 };
    const result = applySettingsChanges(text, from, to);
    expect(result).toContain('// my settings');
    expect(result).toContain('// big');
    expect(parseSettings(result)).toEqual({ 'editor.fontSize': 16, 'git.path': '/usr/bin/git', 'editor.tabSize': 2 });
    expect(result).toMatch(/\n {4}"editor\.tabSize": 2/);
  });

  it('returns the text untouched when nothing differs', () => {
    expect(applySettingsChanges(text, { a: 1 }, { a: 1 })).toBe(text);
  });

  it('keeps tab indentation and CRLF line endings', () => {
    const tabbed = '{\r\n\t"a": 1\r\n}';
    const result = applySettingsChanges(tabbed, { a: 1 }, { a: 1, b: 2 });
    expect(result).toContain('\r\n\t"b": 2');
  });

  it('creates an object from blank text', () => {
    expect(parseSettings(applySettingsChanges('', {}, { a: 1 }))).toEqual({ a: 1 });
  });
});

describe('removeSettings', () => {
  it('removes the given keys', () => {
    expect(parseSettings(removeSettings('{"a": 1, "b": 2}', ['a']))).toEqual({ b: 2 });
  });
});

describe('canonicalKeybindings', () => {
  it('ignores comments and formatting', () => {
    const a = '// Place your key bindings in this file\n[\n  { "key": "ctrl+k", "command": "x" }\n]';
    const b = '[{"command":"x","key":"ctrl+k"}]';
    expect(canonicalKeybindings(a)).toBe(canonicalKeybindings(b));
  });

  it('treats missing files as an empty array and rejects objects', () => {
    expect(canonicalKeybindings(undefined)).toBe('[]');
    expect(() => canonicalKeybindings('{}')).toThrow(/JSON array/);
  });
});

describe('extension lists', () => {
  it('normalizes ids', () => {
    expect(normalizeExtensionIds(['B.x', 'a.y', 'b.X ', ''])).toEqual(['a.y', 'b.x']);
  });

  it('parses and validates extensions.json', () => {
    expect(parseExtensionList('["Z.z", "a.a"]')).toEqual(['a.a', 'z.z']);
    expect(() => parseExtensionList('[1]')).toThrow();
  });
});

describe('parseMeta', () => {
  it('defaults missing data to the current schema and keeps the old one readable', () => {
    expect(parseMeta(undefined)).toEqual({ schemaVersion: 3, resources: {} });
    expect(parseMeta('{"schemaVersion": 1, "resources": {}}').schemaVersion).toBe(1);
    expect(parseMeta('{"schemaVersion": 2, "resources": {}}').schemaVersion).toBe(2);
  });

  it('rejects a schema written by a newer Zoo Sync', () => {
    expect(() => parseMeta('{"schemaVersion": 4, "resources": {}}')).toThrow(/schema version 4/);
  });
});
