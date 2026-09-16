import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_NAME,
  findProfileForWorkspace,
  parseProfiles,
} from '../../src/local/profileStorage';

const USER_DIR = join('/home', 'zoo', '.config', 'Code', 'User');

const storage = (value: Record<string, unknown>) => JSON.stringify(value);

const defaultProfile = {
  id: DEFAULT_PROFILE_ID,
  name: DEFAULT_PROFILE_NAME,
  dir: USER_DIR,
  isDefault: true,
};

describe('parseProfiles', () => {
  it.each([
    ['no storage file', undefined],
    ['blank text', ''],
    ['corrupt JSON', '{"userDataProfiles": ['],
    ['missing key', '{}'],
    ['wrong type', storage({ userDataProfiles: 'nonsense' })],
    ['entries of the wrong shape', storage({ userDataProfiles: [null, 42, {}, { name: 'NoLocation' }] })],
  ])('returns just the Default profile for %s', (_case, json) => {
    expect(parseProfiles(json, USER_DIR)).toEqual([defaultProfile]);
  });

  it('reads stored profiles with a string location', () => {
    const json = storage({
      userDataProfiles: [
        { name: 'Work', location: '-1a2b3c' },
        { name: 'Teaching', location: join(USER_DIR, 'profiles', 'deadbeef') },
      ],
    });

    expect(parseProfiles(json, USER_DIR)).toEqual([
      defaultProfile,
      { id: '-1a2b3c', name: 'Work', dir: join(USER_DIR, 'profiles', '-1a2b3c'), isDefault: false, useDefaultFlags: undefined },
      {
        id: 'deadbeef',
        name: 'Teaching',
        dir: join(USER_DIR, 'profiles', 'deadbeef'),
        isDefault: false,
        useDefaultFlags: undefined,
      },
    ]);
  });

  it('reads a UriComponents location and ignores query or fragment parts', () => {
    const json = storage({
      userDataProfiles: [
        { name: 'Work', location: { scheme: 'file', path: '/home/zoo/.config/Code/User/profiles/abc123/' } },
        { name: 'Demo', location: 'file:///c%3A/Users/zoo/AppData/Roaming/Code/User/profiles/xyz789?rev=2' },
      ],
    });

    const profiles = parseProfiles(json, USER_DIR);
    expect(profiles.map((p) => p.id)).toEqual([DEFAULT_PROFILE_ID, 'abc123', 'xyz789']);
    expect(profiles[1].dir).toBe(join(USER_DIR, 'profiles', 'abc123'));
  });

  it('passes through only the useDefaultFlags that are set', () => {
    const json = storage({
      userDataProfiles: [
        { name: 'Work', location: 'w1', useDefaultFlags: { settings: true, keybindings: false, bogus: true } },
        { name: 'Other', location: 'o1', useDefaultFlags: 'not an object' },
      ],
    });

    const [, work, other] = parseProfiles(json, USER_DIR);
    expect(work.useDefaultFlags).toEqual({ settings: true });
    expect(other.useDefaultFlags).toBeUndefined();
  });

  it('keeps the first of duplicate names or ids, and never shadows Default', () => {
    const json = storage({
      userDataProfiles: [
        { name: 'Work', location: 'w1' },
        { name: 'Work', location: 'w2' },
        { name: 'Second', location: 'w1' },
        { name: DEFAULT_PROFILE_NAME, location: 'w3' },
        { name: '  ', location: 'w4' },
      ],
    });

    expect(parseProfiles(json, USER_DIR).map((p) => [p.name, p.id])).toEqual([
      [DEFAULT_PROFILE_NAME, DEFAULT_PROFILE_ID],
      ['Work', 'w1'],
    ]);
  });
});

describe('findProfileForWorkspace', () => {
  const json = storage({
    userDataProfiles: [{ name: 'Work', location: 'w1' }],
    profileAssociations: {
      workspaces: { 'file:///home/zoo/code/api': 'w1', 'file:///home/zoo/code/gone': 'removed-id' },
      emptyWindows: { '1234': 'w1' },
    },
  });

  it('finds the profile associated with a workspace', () => {
    expect(findProfileForWorkspace(json, 'file:///home/zoo/code/api', USER_DIR)).toBe('Work');
  });

  it('ignores a trailing slash on either side', () => {
    expect(findProfileForWorkspace(json, 'file:///home/zoo/code/api/', USER_DIR)).toBe('Work');
    const withSlash = storage({
      userDataProfiles: [{ name: 'Work', location: 'w1' }],
      profileAssociations: { workspaces: { 'file:///home/zoo/code/api/': 'w1' } },
    });
    expect(findProfileForWorkspace(withSlash, 'file:///home/zoo/code/api', USER_DIR)).toBe('Work');
  });

  it('falls back to Default for a workspace that is not listed', () => {
    expect(findProfileForWorkspace(json, 'file:///home/zoo/code/other', USER_DIR)).toBe(DEFAULT_PROFILE_NAME);
    expect(findProfileForWorkspace('{}', 'file:///home/zoo/code/other', USER_DIR)).toBe(DEFAULT_PROFILE_NAME);
  });

  it('gives up when the window is empty', () => {
    expect(findProfileForWorkspace(json, undefined, USER_DIR)).toBeUndefined();
  });

  it('gives up when the association points at a profile that no longer exists', () => {
    expect(findProfileForWorkspace(json, 'file:///home/zoo/code/gone', USER_DIR)).toBeUndefined();
  });

  it('survives corrupt storage', () => {
    expect(findProfileForWorkspace('{"profileAssociations":', 'file:///x', USER_DIR)).toBe(DEFAULT_PROFILE_NAME);
  });
});
