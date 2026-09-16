import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMeta, parseSettings } from '../../src/sync/documents';
import { SyncEngine, type SyncOptions } from '../../src/sync/engine';
import { gitBlobSha } from '../../src/sync/hash';
import {
  emptyState,
  NonFastForwardError,
  type LocalProfileInfo,
  type LocalState,
  type LocalStore,
  type RemoteStore,
  type StateStore,
  type TextFile,
} from '../../src/sync/ports';
import type { FileSpec } from '../../src/sync/pathSpec';
import type { Platform } from '../../src/sync/types';

let clock = Date.parse('2026-09-16T00:00:00Z');
const tick = () => (clock += 1000);

// Built with join so the fakes speak the same path separators as the engine on every platform.
const USER_DIR = join('/u', 'User');
const HOME_DIR = join('/home', 'me');

class FakeRemote implements RemoteStore {
  private readonly commits = new Map<string, Record<string, string>>();
  private count = 0;
  head: string;
  readCalls: string[] = [];
  messages: string[] = [];
  beforeCommit?: () => void;

  constructor(files: Record<string, string> = { 'README.md': '# sync' }) {
    this.head = this.store(files);
  }

  get files(): Record<string, string> {
    return this.commits.get(this.head) ?? {};
  }

  /** Simulates another machine pushing. */
  push(files: Record<string, string>, removed: string[] = []): void {
    const next = { ...this.files, ...files };
    for (const path of removed) {
      delete next[path];
    }
    this.head = this.store(next);
  }

  async getHead(knownSha?: string): Promise<string | undefined> {
    return knownSha === this.head ? undefined : this.head;
  }

  async listTree(commitSha: string): Promise<Map<string, string>> {
    const files = this.commits.get(commitSha) ?? {};
    return new Map(Object.entries(files).map(([path, content]) => [path, gitBlobSha(content)]));
  }

  async readFile(commitSha: string, path: string): Promise<string | undefined> {
    this.readCalls.push(path);
    return this.commits.get(commitSha)?.[path];
  }

  async commit(
    parentSha: string,
    files: Record<string, string>,
    deletions: readonly string[],
    message: string,
  ): Promise<string> {
    const hook = this.beforeCommit;
    this.beforeCommit = undefined;
    hook?.();
    if (parentSha !== this.head) {
      throw new NonFastForwardError();
    }
    const next = { ...this.commits.get(parentSha), ...files };
    for (const path of deletions) {
      delete next[path];
    }
    this.head = this.store(next);
    this.messages.push(message);
    return this.head;
  }

  private store(files: Record<string, string>): string {
    const sha = `sha${++this.count}`;
    this.commits.set(sha, files);
    return sha;
  }
}

class FakeLocal implements LocalStore {
  readonly homeDir = HOME_DIR;
  readonly files = new Map<string, TextFile>();
  profiles: LocalProfileInfo[] = [{ name: 'Default', dir: USER_DIR, isDefault: true }];
  current: string | undefined = 'Default';
  manageExtensions = true;
  unsaved = false;
  extensions = new Map<string, string[] | undefined>([['Default', []]]);
  readonly failingInstalls = new Set<string>();

  constructor(readonly platform: Platform) {}

  set(path: string, text: string): void {
    this.files.set(path, { text, mtime: tick() });
  }

  async listProfiles(): Promise<LocalProfileInfo[]> {
    return this.profiles;
  }

  async currentProfile(): Promise<string | undefined> {
    return this.current;
  }

  canManageExtensions(): boolean {
    return this.manageExtensions;
  }

  async readFile(path: string): Promise<TextFile | undefined> {
    return this.files.get(path);
  }

  async writeFile(path: string, text: string): Promise<void> {
    this.set(path, text);
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  async listFiles(dir: string, matches: (relativePath: string) => boolean, limit: number): Promise<string[]> {
    return [...this.files.keys()]
      .map((path) => relative(dir, path).split(/[\\/]/).join('/'))
      .filter((path) => path !== '' && !path.startsWith('..'))
      .filter(matches)
      .slice(0, limit);
  }

  hasUnsavedChanges(): boolean {
    return this.unsaved;
  }

  async listExtensions(profile: LocalProfileInfo): Promise<string[] | undefined> {
    return this.extensions.get(profile.name);
  }

  async installExtension(id: string): Promise<void> {
    if (this.failingInstalls.has(id)) {
      throw new Error('not found in marketplace');
    }
    const profile = this.current ?? 'Default';
    this.extensions.set(profile, [...(this.extensions.get(profile) ?? []), id]);
  }

  async uninstallExtension(id: string): Promise<void> {
    const profile = this.current ?? 'Default';
    this.extensions.set(profile, (this.extensions.get(profile) ?? []).filter((existing) => existing !== id));
  }
}

class MemoryState implements StateStore {
  state: LocalState = emptyState();

  async read() {
    return structuredClone(this.state);
  }

  async write(state: LocalState) {
    this.state = structuredClone(state);
  }
}

interface MachineOptions {
  platform?: Platform;
  profiles?: string[];
  files?: FileSpec[];
}

function machine(remote: FakeRemote, name: string, options: MachineOptions = {}) {
  const platform = options.platform ?? 'linux';
  const local = new FakeLocal(platform);
  const state = new MemoryState();
  const warnings: string[] = [];
  const engine = new SyncEngine({
    local,
    remote,
    state,
    logger: { info: () => undefined, warn: (message) => warnings.push(message), error: () => undefined },
    config: {
      profiles: options.profiles ?? ['Default'],
      files: options.files ?? [],
      ignoredSettings: ['git.path', '*Path'],
      ignoredExtensions: ['ignored.*'],
    },
    machine: `${platform}@${name}`,
    now: () => new Date(clock),
  });
  const sync = (overrides: Partial<SyncOptions> = {}) => engine.sync({ localChanged: true, ...overrides });
  return { local, state, engine, sync, warnings };
}

/** Machine `a` uploads first; machine `b` joins with "download". */
async function twoMachines(options: MachineOptions = {}) {
  const remote = new FakeRemote();
  const a = machine(remote, 'a', options);
  a.local.set(join(USER_DIR, 'settings.json'), '{\n  "editor.fontSize": 14\n}');
  a.local.extensions.set('Default', ['x.keep', 'x.drop']);
  await a.sync();
  const b = machine(remote, 'b', options);
  b.local.set(join(USER_DIR, 'settings.json'), '{\n  "git.path": "C:/git"\n}');
  b.local.extensions.set('Default', ['x.keep', 'x.drop']);
  await b.sync({ initialChoice: 'download' });
  return { remote, a, b };
}

describe('SyncEngine', () => {
  it('uploads into the profile layout, without ignored or secret settings', async () => {
    const remote = new FakeRemote();
    const a = machine(remote, 'a');
    a.local.set(
      join(USER_DIR, 'settings.json'),
      '{\n  // font\n  "editor.fontSize": 14,\n  "git.path": "/usr/bin/git",\n  "openai.apiKey": "sk-1"\n}',
    );
    a.local.set(join(USER_DIR, 'keybindings.json'), '[{ "key": "ctrl+k", "command": "x" }]');
    a.local.extensions.set('Default', ['Esbenp.Prettier-VSCode', 'ignored.ext']);

    const report = await a.sync();

    expect(report.outcome).toBe('synced');
    expect(report.uploaded.sort()).toEqual([
      'profiles/Default/extensions.json',
      'profiles/Default/keybindings/linux.json',
      'profiles/Default/settings.json',
    ]);
    expect(remote.files['profiles/Default/settings.json']).toContain('// font');
    expect(parseSettings(remote.files['profiles/Default/settings.json'])).toEqual({ 'editor.fontSize': 14 });
    expect(JSON.parse(remote.files['profiles/Default/extensions.json'])).toEqual(['esbenp.prettier-vscode']);
    const meta = parseMeta(remote.files['meta.json']);
    expect(meta.schemaVersion).toBe(2);
    expect(meta.resources['profiles/Default/settings.json'].updatedBy).toBe('linux@a');
  });

  it('only makes a conditional head check when nothing changed', async () => {
    const { remote, a } = await twoMachines();
    const commits = remote.messages.length;
    remote.readCalls = [];

    const report = await a.sync({ localChanged: false });

    expect(report.outcome).toBe('up-to-date');
    expect(remote.readCalls).toEqual([]);
    expect(remote.messages).toHaveLength(commits);
  });

  it('does not commit when only comments, formatting or ignored keys change', async () => {
    const { remote, a } = await twoMachines();
    const commits = remote.messages.length;
    a.local.set(join(USER_DIR, 'settings.json'), '// reformatted\n{"git.path": "/opt/git", "editor.fontSize":14}');

    expect((await a.sync()).uploaded).toEqual([]);
    expect(remote.messages).toHaveLength(commits);
  });

  it('downloads a file only when its blob id changed', async () => {
    const { remote, a, b } = await twoMachines();
    b.local.set(join(USER_DIR, 'settings.json'), '{"git.path": "C:/git", "editor.fontSize": 16}');
    await b.sync();
    remote.readCalls = [];

    await a.sync({ localChanged: false });

    expect(remote.readCalls).toContain('profiles/Default/settings.json');
    expect(remote.readCalls).not.toContain('profiles/Default/extensions.json');
  });

  it('asks how to start on a new machine and downloads without touching ignored keys', async () => {
    const remote = new FakeRemote();
    const a = machine(remote, 'a');
    a.local.set(join(USER_DIR, 'settings.json'), '{"editor.fontSize": 14}');
    a.local.extensions.set('Default', ['a.one', 'a.two']);
    await a.sync();

    const b = machine(remote, 'b');
    b.local.set(join(USER_DIR, 'settings.json'), '// mine\n{\n  "editor.fontSize": 20,\n  "git.path": "C:/git"\n}');
    b.local.extensions.set('Default', ['a.one', 'b.extra']);
    expect((await b.sync()).outcome).toBe('needs-initial-choice');

    const report = await b.sync({ initialChoice: 'download' });

    expect(parseSettings(b.local.files.get(join(USER_DIR, 'settings.json'))?.text)).toEqual({
      'editor.fontSize': 14,
      'git.path': 'C:/git',
    });
    expect(b.local.files.get(join(USER_DIR, 'settings.json'))?.text).toContain('// mine');
    expect(report.installed).toEqual(['a.two']);
    expect(report.pendingUninstall).toEqual(['b.extra']);
    expect(report.uploaded).toEqual([]);
  });

  it('merges edits to different keys and resolves conflicts by update time', async () => {
    const { remote, a, b } = await twoMachines();
    a.local.set(join(USER_DIR, 'settings.json'), '{"editor.fontSize": 16}');
    await a.sync();
    b.local.set(join(USER_DIR, 'settings.json'), '{"editor.fontSize": 14, "git.path": "C:/git", "editor.tabSize": 2}');
    await b.sync();
    await a.sync({ localChanged: false });

    const expected = { 'editor.fontSize': 16, 'editor.tabSize': 2 };
    expect(parseSettings(remote.files['profiles/Default/settings.json'])).toEqual(expected);
    expect(parseSettings(a.local.files.get(join(USER_DIR, 'settings.json'))?.text)).toEqual(expected);

    // Now both change the same key; the newer edit wins.
    a.local.set(join(USER_DIR, 'settings.json'), '{"editor.fontSize": 18, "editor.tabSize": 2}');
    await a.sync();
    b.local.set(join(USER_DIR, 'settings.json'), '{"editor.fontSize": 20, "editor.tabSize": 2, "git.path": "C:/git"}');
    const report = await b.sync();
    expect(report.conflicts).toEqual(['profiles/Default/settings.json']);
    expect(parseSettings(remote.files['profiles/Default/settings.json'])['editor.fontSize']).toBe(20);
  });

  it('keeps keybindings per platform and preserves comments on download', async () => {
    const remote = new FakeRemote();
    const win = machine(remote, 'w', { platform: 'windows' });
    win.local.set(join(USER_DIR, 'keybindings.json'), '// win\n[{"key":"ctrl+a","command":"a"}]');
    await win.sync();
    const mac = machine(remote, 'm', { platform: 'macos' });
    mac.local.set(join(USER_DIR, 'keybindings.json'), '[{"key":"cmd+a","command":"a"}]');
    await mac.sync({ initialChoice: 'merge' });

    expect(remote.files['profiles/Default/keybindings/windows.json']).toContain('// win');
    expect(remote.files['profiles/Default/keybindings/macos.json']).toContain('cmd+a');

    const win2 = machine(remote, 'w2', { platform: 'windows' });
    await win2.sync({ initialChoice: 'download' });
    expect(win2.local.files.get(join(USER_DIR, 'keybindings.json'))?.text).toBe('// win\n[{"key":"ctrl+a","command":"a"}]');
  });

  it('syncs profile-relative and home files, and skips credential-looking names', async () => {
    const files: FileSpec[] = ['snippets/**', '~/.gitconfig'];
    const remote = new FakeRemote();
    const a = machine(remote, 'a', { files });
    a.local.set(join(USER_DIR, 'snippets/py.json'), '{ "a": 1 }');
    a.local.set(join(USER_DIR, 'snippets/id_rsa'), 'secret');
    a.local.set(join(HOME_DIR, '.gitconfig'), '[user]\n\tname = me\n');
    await a.sync();

    expect(Object.keys(remote.files).sort()).toContain('files/common/.gitconfig');
    expect(remote.files['profiles/Default/files/common/snippets/py.json']).toBe('{ "a": 1 }');
    expect(Object.keys(remote.files)).not.toContain('profiles/Default/files/common/snippets/id_rsa');
    expect(a.warnings.some((warning) => warning.includes('id_rsa'))).toBe(true);

    const b = machine(remote, 'b', { files });
    await b.sync({ initialChoice: 'download' });
    expect(b.local.files.get(join(USER_DIR, 'snippets/py.json'))?.text).toBe('{ "a": 1 }');
    expect(b.local.files.get(join(HOME_DIR, '.gitconfig'))?.text).toBe('[user]\n\tname = me\n');
  });

  it('propagates a locally deleted file and asks before deleting one removed elsewhere', async () => {
    const files: FileSpec[] = ['snippets/**'];
    const remote = new FakeRemote();
    const a = machine(remote, 'a', { files });
    a.local.set(join(USER_DIR, 'snippets/py.json'), '{ "a": 1 }');
    a.local.set(join(USER_DIR, 'snippets/go.json'), '{ "b": 2 }');
    await a.sync();
    const b = machine(remote, 'b', { files });
    await b.sync({ initialChoice: 'download' });

    a.local.files.delete(join(USER_DIR, 'snippets/go.json'));
    const upload = await a.sync();
    expect(upload.removed).toEqual(['profiles/Default/files/common/snippets/go.json']);
    expect(Object.keys(remote.files)).not.toContain('profiles/Default/files/common/snippets/go.json');

    const download = await b.sync({ localChanged: false });
    expect(download.pendingDeletions).toEqual([join(USER_DIR, 'snippets/go.json')]);
    expect(b.local.files.has(join(USER_DIR, 'snippets/go.json'))).toBe(true);

    // Keeping the file stops it from being synced, instead of re-uploading it forever.
    expect(await b.engine.resolvePendingDeletions([])).toEqual([]);
    const after = await b.sync();
    expect(after.uploaded).toEqual([]);
    expect(b.local.files.has(join(USER_DIR, 'snippets/go.json'))).toBe(true);
  });

  it('deletes a file the user confirms, keeping the other one', async () => {
    const files: FileSpec[] = ['snippets/**'];
    const remote = new FakeRemote();
    const a = machine(remote, 'a', { files });
    a.local.set(join(USER_DIR, 'snippets/py.json'), '{ "a": 1 }');
    await a.sync();
    const b = machine(remote, 'b', { files });
    await b.sync({ initialChoice: 'download' });

    a.local.files.delete(join(USER_DIR, 'snippets/py.json'));
    await a.sync();
    await b.sync({ localChanged: false });

    expect(await b.engine.resolvePendingDeletions([join(USER_DIR, 'snippets/py.json')])).toEqual([
      join(USER_DIR, 'snippets/py.json'),
    ]);
    expect(b.local.files.has(join(USER_DIR, 'snippets/py.json'))).toBe(false);
    expect((await b.sync()).uploaded).toEqual([]);
  });

  it('syncs each profile separately', async () => {
    const profiles = ['Default', 'Work'];
    const remote = new FakeRemote();
    const a = machine(remote, 'a', { profiles });
    a.local.profiles = [
      { name: 'Default', dir: USER_DIR, isDefault: true },
      { name: 'Work', dir: join(USER_DIR, 'profiles/w1'), isDefault: false },
    ];
    a.local.extensions.set('Work', ['work.ext']);
    a.local.set(join(USER_DIR, 'settings.json'), '{"editor.fontSize": 14}');
    a.local.set(join(USER_DIR, 'profiles/w1/settings.json'), '{"editor.fontSize": 20}');

    await a.sync();

    expect(parseSettings(remote.files['profiles/Default/settings.json'])).toEqual({ 'editor.fontSize': 14 });
    expect(parseSettings(remote.files['profiles/Work/settings.json'])).toEqual({ 'editor.fontSize': 20 });
    expect(JSON.parse(remote.files['profiles/Work/extensions.json'])).toEqual(['work.ext']);
  });

  it('reports profiles that are configured but missing, and ones only in the repository', async () => {
    const remote = new FakeRemote();
    const a = machine(remote, 'a', { profiles: ['Default', 'Work'] });
    a.local.set(join(USER_DIR, 'settings.json'), '{"editor.fontSize": 14}');
    const first = await a.sync();
    expect(first.missingProfiles).toEqual(['Work']);
    expect(Object.keys(remote.files)).not.toContain('profiles/Work/settings.json');

    const b = machine(remote, 'b', { profiles: ['Default'] });
    remote.push({ 'profiles/Other/settings.json': '{}' });
    const second = await b.sync({ initialChoice: 'download' });
    expect(second.unconfiguredProfiles).toEqual(['Other']);
    expect(remote.files['profiles/Other/settings.json']).toBe('{}');
  });

  it('installs extensions only in a window whose profile it can identify', async () => {
    const remote = new FakeRemote();
    const a = machine(remote, 'a');
    a.local.extensions.set('Default', ['a.one']);
    await a.sync();

    const b = machine(remote, 'b');
    b.local.current = undefined; // empty window: the active profile is unknown
    b.local.extensions.set('Default', []);
    const report = await b.sync({ initialChoice: 'download' });

    expect(report.installed).toEqual([]);
    expect(JSON.parse(remote.files['profiles/Default/extensions.json'])).toEqual(['a.one']);
  });

  it('offers to uninstall extensions removed elsewhere and remembers the ones kept', async () => {
    const { remote, a, b } = await twoMachines();
    a.local.extensions.set('Default', []);
    await a.sync();

    const report = await b.sync({ localChanged: false });
    expect(report.pendingUninstall).toEqual(['x.drop', 'x.keep']);
    expect((await b.sync()).uploaded).toEqual([]);

    expect(await b.engine.resolvePendingUninstall('Default', ['x.drop'])).toEqual(['x.drop']);
    expect(b.local.extensions.get('Default')).toEqual(['x.keep']);

    const after = await b.sync();
    expect(after).toMatchObject({ uploaded: [], pendingUninstall: [] });
    expect(JSON.parse(remote.files['profiles/Default/extensions.json'])).toEqual([]);
  });

  it('keeps extensions in the repository when they cannot be installed here', async () => {
    const remote = new FakeRemote();
    const a = machine(remote, 'a');
    a.local.extensions.set('Default', ['vendor.private']);
    await a.sync();
    const b = machine(remote, 'b');
    b.local.failingInstalls.add('vendor.private');

    await b.sync({ initialChoice: 'download' });
    await b.sync();

    expect(b.warnings.some((warning) => warning.includes('Could not install extension vendor.private'))).toBe(true);
    expect(JSON.parse(remote.files['profiles/Default/extensions.json'])).toEqual(['vendor.private']);
  });

  it('moves a schema 1 repository into the profile layout', async () => {
    const remote = new FakeRemote({
      'meta.json': JSON.stringify({
        schemaVersion: 1,
        resources: { settings: { updatedAt: '2026-09-15T00:00:00.000Z', updatedBy: 'linux@old' } },
      }),
      'settings.json': '// old\n{"editor.fontSize": 14}',
      'keybindings/linux.json': '[{"key":"ctrl+a","command":"a"}]',
      'keybindings/windows.json': '[{"key":"ctrl+b","command":"b"}]',
      'extensions.json': '["a.one"]',
    });
    const a = machine(remote, 'a');
    a.local.set(join(USER_DIR, 'settings.json'), '// old\n{"editor.fontSize": 14}');
    a.local.set(join(USER_DIR, 'keybindings.json'), '[{"key":"ctrl+a","command":"a"}]');
    a.local.extensions.set('Default', ['a.one']);

    const report = await a.sync({ initialChoice: 'download' });

    expect(Object.keys(remote.files).sort()).toEqual([
      'meta.json',
      'profiles/Default/extensions.json',
      'profiles/Default/keybindings/linux.json',
      'profiles/Default/keybindings/windows.json',
      'profiles/Default/settings.json',
    ]);
    expect(remote.files['profiles/Default/settings.json']).toContain('// old');
    const meta = parseMeta(remote.files['meta.json']);
    expect(meta.schemaVersion).toBe(2);
    expect(meta.resources['profiles/Default/settings.json'].updatedBy).toBe('linux@old');
    expect(report.outcome).toBe('synced');
    // Nothing else to do afterwards.
    expect((await a.sync()).uploaded).toEqual([]);
  });

  it('retries on top of a concurrent push', async () => {
    const { remote, a } = await twoMachines();
    a.local.set(join(USER_DIR, 'settings.json'), '{"editor.fontSize": 14, "editor.tabSize": 4}');
    remote.beforeCommit = () => remote.push({ 'profiles/Default/extensions.json': '["x.drop", "x.keep", "x.new"]\n' });

    const report = await a.sync();

    expect(report.outcome).toBe('synced');
    expect(a.warnings.some((warning) => warning.includes('retrying'))).toBe(true);
    expect(parseSettings(remote.files['profiles/Default/settings.json'])).toEqual({
      'editor.fontSize': 14,
      'editor.tabSize': 4,
    });
    expect(a.local.extensions.get('Default')).toContain('x.new');
  });

  it('skips while a synced file has unsaved edits', async () => {
    const { a } = await twoMachines();
    a.local.unsaved = true;
    expect((await a.sync()).outcome).toBe('skipped');
  });

  it('refuses to sync a settings file with syntax errors', async () => {
    const { remote, a } = await twoMachines();
    const commits = remote.messages.length;
    a.local.set(join(USER_DIR, 'settings.json'), '{ "editor.fontSize": }');

    await expect(a.sync()).rejects.toThrow(/syntax errors/);
    expect(remote.messages).toHaveLength(commits);
  });
});
