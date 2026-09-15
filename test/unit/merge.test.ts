import { describe, expect, it } from 'vitest';
import { mergeExtensions, mergeKeybindings, mergeSettings, mergeValue } from '../../src/sync/merge';

describe('mergeValue', () => {
  it('takes the side that changed', () => {
    expect(mergeValue(1, 2, 1, 'remote')).toEqual({ value: 2, conflict: false });
    expect(mergeValue(1, 1, 3, 'local')).toEqual({ value: 3, conflict: false });
  });

  it('is not a conflict when both sides made the same change', () => {
    expect(mergeValue(1, 2, 2, 'remote')).toEqual({ value: 2, conflict: false });
  });

  it('resolves real conflicts with the given winner', () => {
    expect(mergeValue(1, 2, 3, 'local')).toEqual({ value: 2, conflict: true });
    expect(mergeValue(1, 2, 3, 'remote')).toEqual({ value: 3, conflict: true });
  });

  it('compares structurally, ignoring key order', () => {
    expect(mergeValue({ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1, b: 3 }, 'local').conflict).toBe(false);
  });
});

describe('mergeSettings', () => {
  const base = { 'editor.fontSize': 14, 'editor.tabSize': 2, 'files.autoSave': 'off' };

  it('combines changes to different keys from both sides', () => {
    const local = { ...base, 'editor.fontSize': 16 };
    const remote = { ...base, 'editor.tabSize': 4 };
    expect(mergeSettings(base, local, remote, 'remote')).toEqual({
      merged: { 'editor.fontSize': 16, 'editor.tabSize': 4, 'files.autoSave': 'off' },
      conflicts: [],
    });
  });

  it('propagates deletions and additions', () => {
    const local = { 'editor.fontSize': 14, 'editor.tabSize': 2, 'new.local': true };
    const remote = { ...base, 'new.remote': 1 };
    const { merged } = mergeSettings(base, local, remote, 'remote');
    expect(merged).toEqual({ 'editor.fontSize': 14, 'editor.tabSize': 2, 'new.local': true, 'new.remote': 1 });
  });

  it('reports conflicting keys and applies the winner', () => {
    const local = { ...base, 'editor.fontSize': 16 };
    const remote = { ...base, 'editor.fontSize': 18 };
    expect(mergeSettings(base, local, remote, 'local')).toEqual({
      merged: { ...base, 'editor.fontSize': 16 },
      conflicts: ['editor.fontSize'],
    });
    expect(mergeSettings(base, local, remote, 'remote').merged['editor.fontSize']).toBe(18);
  });

  it('treats a missing remote document as unchanged', () => {
    const local = { ...base, 'editor.fontSize': 16 };
    expect(mergeSettings(base, local, undefined, 'remote').merged).toEqual(local);
  });

  it('handles keys named like prototype members', () => {
    const { merged } = mergeSettings({}, { constructor: 1 }, {}, 'remote');
    expect(merged).toEqual({ constructor: 1 });
  });
});

describe('mergeKeybindings', () => {
  it('takes remote when only remote changed and local on conflict when local wins', () => {
    expect(mergeKeybindings('[]', '[]', '[1]', 'local')).toEqual({ merged: '[1]', conflict: false });
    expect(mergeKeybindings('[]', '[2]', '[1]', 'local')).toEqual({ merged: '[2]', conflict: true });
  });

  it('keeps local when the remote file does not exist', () => {
    expect(mergeKeybindings(undefined, '[2]', undefined, 'remote')).toEqual({ merged: '[2]', conflict: false });
  });
});

describe('mergeExtensions', () => {
  it('applies additions and removals from both sides', () => {
    const base = ['a', 'b', 'c'];
    const local = ['a', 'b', 'd']; // removed c, added d
    const remote = ['b', 'c', 'e']; // removed a, added e
    expect(mergeExtensions(base, local, remote)).toEqual(['b', 'd', 'e']);
  });

  it('unions when there is no base', () => {
    expect(mergeExtensions(undefined, ['b', 'a'], ['c'])).toEqual(['a', 'b', 'c']);
  });

  it('treats a missing remote list as unchanged', () => {
    expect(mergeExtensions(['a'], ['a', 'b'], undefined)).toEqual(['a', 'b']);
  });
});
