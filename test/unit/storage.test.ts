import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileLock, type LockResult } from '../../src/sync/lock';
import { emptyState } from '../../src/sync/ports';
import { FileStateStore } from '../../src/sync/stateStore';
import type { Platform } from '../../src/sync/types';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoo-sync-'));
});

describe('FileLock', () => {
  it('lets one holder run at a time and releases afterwards', async () => {
    const file = join(dir, 'sync.lock');
    let inner: LockResult<number> | undefined;

    const outer = await new FileLock(file).run(async () => {
      inner = await new FileLock(file).run(async () => 2);
      return 1;
    });

    expect(outer).toEqual({ acquired: true, value: 1 });
    expect(inner).toEqual({ acquired: false });
    expect(await new FileLock(file).run(async () => 3)).toEqual({ acquired: true, value: 3 });
  });

  it('takes over a stale lock', async () => {
    const file = join(dir, 'sync.lock');
    await writeFile(file, '999');
    const old = new Date(Date.now() - 10_000);
    await utimes(file, old, old);

    expect(await new FileLock(file, 5_000).run(async () => 'ok')).toEqual({ acquired: true, value: 'ok' });
  });

  it('releases the lock when the task throws', async () => {
    const file = join(dir, 'sync.lock');
    await expect(new FileLock(file).run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await new FileLock(file).run(async () => 1)).toEqual({ acquired: true, value: 1 });
  });
});

describe('FileStateStore', () => {
  const store = (file: string, repository = 'me/sync@main', platform: Platform = 'linux', appId = 'code') =>
    new FileStateStore(file, repository, platform, appId);

  const base = {
    commitSha: 'c1',
    resources: {
      'profiles/Default/settings.json': { canonical: '{"editor.fontSize":14}', blobSha: 'b1' },
    },
    meta: {
      schemaVersion: 3 as const,
      resources: { 'profiles/Default/settings.json': { updatedAt: '2026-09-16T00:00:00.000Z', updatedBy: 'linux@a' } },
    },
  };

  it('round-trips state for the same repository', async () => {
    const file = join(dir, 'nested', 'state.json');
    const state = {
      base,
      extensions: { Default: { localOnly: ['a.b'], pendingUninstall: [], unavailable: [] } },
      pendingDeletions: [{ remotePath: 'files/common/.gitconfig', localPath: '/home/me/.gitconfig' }],
      localOnlyFiles: ['files/common/.bashrc'],
    };
    await store(file).write(state);
    expect(await store(file).read()).toEqual(state);
  });

  it('ignores state recorded for another repository', async () => {
    const file = join(dir, 'state.json');
    await store(file, 'me/old@main').write({ ...emptyState(), localOnlyFiles: ['files/common/x'] });
    expect(await store(file, 'me/new@main').read()).toEqual(emptyState());
  });

  it('treats a corrupt file as empty and can clear it', async () => {
    const file = join(dir, 'state.json');
    await writeFile(file, '{not json');
    expect(await store(file).read()).toEqual(emptyState());
    await store(file).write(emptyState());
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 3, repository: 'me/sync@main' });
    await store(file).clear();
    expect(await store(file).read()).toEqual(emptyState());
  });

  it('upgrades schema 1 state onto the profile layout instead of starting over', async () => {
    const file = join(dir, 'state.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        repository: 'me/sync@main',
        base: {
          commitSha: 'c9',
          settings: { 'editor.fontSize': 14 },
          keybindings: '[{"command":"x","key":"ctrl+k"}]',
          extensions: ['a.b'],
          meta: {
            schemaVersion: 1,
            resources: {
              settings: { updatedAt: '2026-09-15T00:00:00.000Z', updatedBy: 'macos@a' },
              'keybindings.macos': { updatedAt: '2026-09-15T00:00:01.000Z', updatedBy: 'macos@a' },
              extensions: { updatedAt: '2026-09-15T00:00:02.000Z', updatedBy: 'macos@a' },
            },
          },
        },
        localOnlyExtensions: ['keep.me'],
        pendingUninstall: [],
        unavailableExtensions: ['vendor.private'],
      }),
    );

    const state = await store(file, 'me/sync@main', 'macos').read();

    // A base means the upgraded machine is not asked how to start again.
    expect(state).not.toEqual(emptyState());
    expect(state.base?.commitSha).toBe('c9');
    expect(state.base?.resources).toEqual({
      'profiles/Default/settings.json': { canonical: '{"editor.fontSize":14}', blobSha: '' },
      'profiles/Default/extensions.code.json': { canonical: '["a.b"]', blobSha: '' },
      'profiles/Default/keybindings/macos.json': { canonical: '[{"command":"x","key":"ctrl+k"}]', blobSha: '' },
    });
    expect(state.base?.meta).toEqual({
      schemaVersion: 3,
      resources: {
        'profiles/Default/settings.json': { updatedAt: '2026-09-15T00:00:00.000Z', updatedBy: 'macos@a' },
        'profiles/Default/keybindings/macos.json': { updatedAt: '2026-09-15T00:00:01.000Z', updatedBy: 'macos@a' },
        'profiles/Default/extensions.code.json': { updatedAt: '2026-09-15T00:00:02.000Z', updatedBy: 'macos@a' },
      },
    });
    expect(state.extensions).toEqual({
      Default: { localOnly: ['keep.me'], pendingUninstall: [], unavailable: ['vendor.private'] },
    });
  });

  it('renames schema 2 state so each editor keeps its own extension list', async () => {
    const file = join(dir, 'state.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        repository: 'me/sync@main',
        base: {
          commitSha: 'c2',
          resources: {
            'profiles/Default/settings.json': { canonical: '{}', blobSha: 'b1' },
            'profiles/Default/extensions.json': { canonical: '["a.b"]', blobSha: 'b2' },
          },
          meta: { schemaVersion: 2, resources: { 'profiles/Default/extensions.json': { updatedAt: 'x', updatedBy: 'y' } } },
        },
        extensions: {},
        pendingDeletions: [],
        localOnlyFiles: [],
      }),
    );

    const state = await store(file, 'me/sync@main', 'linux', 'cursor').read();

    expect(Object.keys(state.base?.resources ?? {})).toEqual([
      'profiles/Default/settings.json',
      'profiles/Default/extensions.cursor.json',
    ]);
    expect(state.base?.meta.resources['profiles/Default/extensions.cursor.json']).toBeDefined();
    expect(state.base?.meta.schemaVersion).toBe(3);
  });

  it('keeps a schema 1 file for another repository out of the upgrade', async () => {
    const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ version: 1, repository: 'me/old@main', localOnlyExtensions: ['a.b'] }));
    expect(await store(file, 'me/new@main').read()).toEqual(emptyState());
  });
});
