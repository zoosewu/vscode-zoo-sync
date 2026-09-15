import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileLock, type LockResult } from '../../src/sync/lock';
import { emptyState } from '../../src/sync/ports';
import { FileStateStore } from '../../src/sync/stateStore';

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
  it('round-trips state for the same repository', async () => {
    const store = new FileStateStore(join(dir, 'nested', 'state.json'), 'me/sync@main');
    const state = { ...emptyState(), localOnlyExtensions: ['a.b'] };
    await store.write(state);
    expect(await store.read()).toEqual(state);
  });

  it('ignores state recorded for another repository', async () => {
    const file = join(dir, 'state.json');
    await new FileStateStore(file, 'me/old@main').write({ ...emptyState(), pendingUninstall: ['x.y'] });
    expect(await new FileStateStore(file, 'me/new@main').read()).toEqual(emptyState());
  });

  it('treats a corrupt file as empty and can clear it', async () => {
    const file = join(dir, 'state.json');
    await writeFile(file, '{not json');
    const store = new FileStateStore(file, 'me/sync@main');
    expect(await store.read()).toEqual(emptyState());
    await store.write(emptyState());
    expect(JSON.parse(await readFile(file, 'utf8')).repository).toBe('me/sync@main');
    await store.clear();
    expect(await store.read()).toEqual(emptyState());
  });
});
