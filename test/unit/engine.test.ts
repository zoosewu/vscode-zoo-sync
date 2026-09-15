import { describe, expect, it } from 'vitest';
import { parseMeta, parseSettings } from '../../src/sync/documents';
import { SyncEngine, type SyncOptions } from '../../src/sync/engine';
import {
  emptyState,
  NonFastForwardError,
  type LocalState,
  type LocalStore,
  type RemoteStore,
  type StateStore,
  type TextFile,
} from '../../src/sync/ports';
import type { Platform } from '../../src/sync/types';

let clock = Date.parse('2026-09-15T00:00:00Z');
const tick = () => (clock += 1000);

class FakeRemote implements RemoteStore {
  private readonly commits = new Map<string, Record<string, string>>();
  private count = 0;
  head: string;
  readCalls = 0;
  messages: string[] = [];
  beforeCommit?: () => void;

  constructor(files: Record<string, string> = { 'README.md': '# sync' }) {
    this.head = this.store(files);
  }

  get files(): Record<string, string> {
    return this.commits.get(this.head) ?? {};
  }

  /** Simulates another machine pushing. */
  push(files: Record<string, string>): void {
    this.head = this.store({ ...this.files, ...files });
  }

  async getHead(knownSha?: string): Promise<string | undefined> {
    return knownSha === this.head ? undefined : this.head;
  }

  async readFile(commitSha: string, path: string): Promise<string | undefined> {
    this.readCalls++;
    return this.commits.get(commitSha)?.[path];
  }

  async commit(parentSha: string, files: Record<string, string>, message: string): Promise<string> {
    const hook = this.beforeCommit;
    this.beforeCommit = undefined;
    hook?.();
    if (parentSha !== this.head) {
      throw new NonFastForwardError();
    }
    this.head = this.store({ ...this.commits.get(parentSha), ...files });
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
  settings?: TextFile;
  keybindings?: TextFile;
  extensions: string[] | undefined = [];
  unsaved = false;
  readonly failingInstalls = new Set<string>();

  constructor(readonly platform: Platform) {}

  setSettings(text: string): void {
    this.settings = { text, mtime: tick() };
  }

  setKeybindings(text: string): void {
    this.keybindings = { text, mtime: tick() };
  }

  async readSettings() {
    return this.settings;
  }

  async writeSettings(text: string) {
    this.setSettings(text);
  }

  async readKeybindings() {
    return this.keybindings;
  }

  async writeKeybindings(text: string) {
    this.setKeybindings(text);
  }

  hasUnsavedChanges() {
    return this.unsaved;
  }

  async listExtensions() {
    return this.extensions && [...this.extensions];
  }

  async installExtension(id: string) {
    if (this.failingInstalls.has(id)) {
      throw new Error('not found in marketplace');
    }
    this.extensions?.push(id);
  }

  async uninstallExtension(id: string) {
    this.extensions = this.extensions?.filter((e) => e !== id);
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

function machine(remote: FakeRemote, name: string, platform: Platform = 'linux') {
  const local = new FakeLocal(platform);
  const state = new MemoryState();
  const warnings: string[] = [];
  const engine = new SyncEngine({
    local,
    remote,
    state,
    logger: { info: () => undefined, warn: (m) => warnings.push(m), error: () => undefined },
    config: { ignoredSettings: ['git.path', '*Path'], ignoredExtensions: ['ignored.*'] },
    machine: `${platform}@${name}`,
    now: () => new Date(clock),
  });
  const sync = (options: Partial<SyncOptions> = {}) => engine.sync({ localChanged: true, ...options });
  return { local, state, engine, sync, warnings };
}

/** Machine `a` uploads first, machine `b` joins with "download". */
async function twoMachines() {
  const remote = new FakeRemote();
  const a = machine(remote, 'a');
  a.local.setSettings('{\n  "editor.fontSize": 14\n}');
  a.local.extensions = ['x.keep', 'x.drop'];
  await a.sync();
  const b = machine(remote, 'b');
  b.local.setSettings('{\n  "git.path": "C:/git"\n}');
  b.local.extensions = ['x.keep', 'x.drop'];
  await b.sync({ initialChoice: 'download' });
  return { remote, a, b };
}

describe('SyncEngine', () => {
  it('uploads everything to an empty remote without ignored or secret settings', async () => {
    const remote = new FakeRemote();
    const a = machine(remote, 'a');
    a.local.setSettings('{\n  // font\n  "editor.fontSize": 14,\n  "git.path": "/usr/bin/git",\n  "openai.apiKey": "sk-1"\n}');
    a.local.setKeybindings('[{ "key": "ctrl+k", "command": "x" }]');
    a.local.extensions = ['Esbenp.Prettier-VSCode', 'ignored.ext'];

    const report = await a.sync();

    expect(report.outcome).toBe('synced');
    expect(report.uploaded).toEqual(['settings', 'keybindings.linux', 'extensions']);
    expect(remote.files['settings.json']).toContain('// font');
    expect(parseSettings(remote.files['settings.json'])).toEqual({ 'editor.fontSize': 14 });
    expect(remote.files['keybindings/linux.json']).toBe('[{ "key": "ctrl+k", "command": "x" }]');
    expect(JSON.parse(remote.files['extensions.json'])).toEqual(['esbenp.prettier-vscode']);
    const meta = parseMeta(remote.files['meta.json']);
    expect(meta.resources.settings.updatedBy).toBe('linux@a');
    expect(Date.parse(meta.resources.settings.updatedAt)).toBe(a.local.settings?.mtime);
    expect(remote.messages[0]).toMatch(/^sync: settings, keybindings\.linux, extensions from linux@a at 2026-/);
  });

  it('only makes a conditional head check when nothing changed', async () => {
    const { remote, a } = await twoMachines();
    const commits = remote.messages.length;
    remote.readCalls = 0;

    const report = await a.sync({ localChanged: false });

    expect(report.outcome).toBe('up-to-date');
    expect(remote.readCalls).toBe(0);
    expect(remote.messages).toHaveLength(commits);
  });

  it('does not commit when only comments, formatting or ignored keys change', async () => {
    const { remote, a } = await twoMachines();
    const commits = remote.messages.length;
    a.local.setSettings('// reformatted\n{"git.path": "/opt/git", "editor.fontSize":14}');

    const report = await a.sync();

    expect(report.uploaded).toEqual([]);
    expect(remote.messages).toHaveLength(commits);
  });

  it('does not commit when another machine only rewrote meta.json', async () => {
    const { remote, a } = await twoMachines();
    const commits = remote.messages.length;
    remote.push({ 'meta.json': '{"schemaVersion":1,"resources":{"settings":{"updatedAt":"2030-01-01T00:00:00Z","updatedBy":"x"}}}' });

    const report = await a.sync({ localChanged: false });

    expect(report).toMatchObject({ outcome: 'up-to-date', uploaded: [], applied: [] });
    expect(remote.messages).toHaveLength(commits);
  });

  it('asks how to start on a new machine and downloads without touching ignored keys', async () => {
    const remote = new FakeRemote();
    const a = machine(remote, 'a');
    a.local.setSettings('{"editor.fontSize": 14}');
    a.local.extensions = ['a.one', 'a.two'];
    await a.sync();

    const b = machine(remote, 'b');
    b.local.setSettings('// mine\n{\n  "editor.fontSize": 20,\n  "git.path": "C:/git"\n}');
    b.local.extensions = ['a.one', 'b.extra'];
    expect((await b.sync()).outcome).toBe('needs-initial-choice');

    const report = await b.sync({ initialChoice: 'download' });

    expect(parseSettings(b.local.settings?.text)).toEqual({ 'editor.fontSize': 14, 'git.path': 'C:/git' });
    expect(b.local.settings?.text).toContain('// mine');
    expect(report.installed).toEqual(['a.two']);
    expect(report.pendingUninstall).toEqual(['b.extra']);
    expect(report.uploaded).toEqual([]);
  });

  it('merges edits to different keys from two machines', async () => {
    const { remote, a, b } = await twoMachines();
    a.local.setSettings('{"editor.fontSize": 16}');
    await a.sync();
    b.local.setSettings('{"editor.fontSize": 14, "git.path": "C:/git", "editor.tabSize": 2}');
    await b.sync();
    await a.sync({ localChanged: false });

    const expected = { 'editor.fontSize': 16, 'editor.tabSize': 2 };
    expect(parseSettings(remote.files['settings.json'])).toEqual(expected);
    expect(parseSettings(a.local.settings?.text)).toEqual(expected);
    expect(parseSettings(b.local.settings?.text)).toEqual({ ...expected, 'git.path': 'C:/git' });
  });

  it('resolves a conflicting key with the newer remote change', async () => {
    const { a, b } = await twoMachines();
    b.local.setSettings('{"editor.fontSize": 18, "git.path": "C:/git"}'); // older edit
    a.local.setSettings('{"editor.fontSize": 16}'); // newer edit, uploaded first
    await a.sync();

    const report = await b.sync();

    expect(report.conflicts).toEqual(['settings:editor.fontSize']);
    expect(parseSettings(b.local.settings?.text)['editor.fontSize']).toBe(16);
  });

  it('resolves a conflicting key with the newer local change', async () => {
    const { remote, a, b } = await twoMachines();
    a.local.setSettings('{"editor.fontSize": 16}');
    await a.sync();
    b.local.setSettings('{"editor.fontSize": 18, "git.path": "C:/git"}'); // newer edit

    const report = await b.sync();

    expect(report.conflicts).toEqual(['settings:editor.fontSize']);
    expect(parseSettings(remote.files['settings.json'])['editor.fontSize']).toBe(18);
  });

  it('keeps keybindings per platform and preserves comments on download', async () => {
    const remote = new FakeRemote();
    const win = machine(remote, 'w', 'windows');
    win.local.setKeybindings('// win\n[{"key":"ctrl+a","command":"a"}]');
    await win.sync();
    const mac = machine(remote, 'm', 'macos');
    mac.local.setKeybindings('[{"key":"cmd+a","command":"a"}]');
    await mac.sync({ initialChoice: 'merge' });

    expect(remote.files['keybindings/windows.json']).toContain('// win');
    expect(remote.files['keybindings/macos.json']).toContain('cmd+a');

    const win2 = machine(remote, 'w2', 'windows');
    await win2.sync({ initialChoice: 'download' });
    expect(win2.local.keybindings?.text).toBe('// win\n[{"key":"ctrl+a","command":"a"}]');
  });

  it('offers to uninstall extensions removed elsewhere and remembers the ones kept', async () => {
    const { remote, a, b } = await twoMachines();
    a.local.extensions = [];
    await a.sync();

    const report = await b.sync({ localChanged: false });
    expect(report.pendingUninstall).toEqual(['x.drop', 'x.keep']);
    // Still pending: nothing is re-uploaded.
    expect((await b.sync()).uploaded).toEqual([]);

    expect(await b.engine.resolvePendingUninstall(['x.drop'])).toEqual(['x.drop']);
    expect(b.local.extensions).toEqual(['x.keep']);

    const after = await b.sync();
    expect(after).toMatchObject({ uploaded: [], pendingUninstall: [] });
    expect(JSON.parse(remote.files['extensions.json'])).toEqual([]);
  });

  it('keeps extensions in the remote list when they cannot be installed here', async () => {
    const remote = new FakeRemote();
    const a = machine(remote, 'a');
    a.local.extensions = ['vendor.private'];
    await a.sync();
    const b = machine(remote, 'b');
    b.local.failingInstalls.add('vendor.private');

    await b.sync({ initialChoice: 'download' });
    await b.sync();

    expect(b.warnings.some((w) => w.includes('Could not install extension vendor.private'))).toBe(true);
    expect(JSON.parse(remote.files['extensions.json'])).toEqual(['vendor.private']);
  });

  it('leaves the extension list alone in windows that cannot manage extensions', async () => {
    const { remote } = await twoMachines();
    const remoteWindow = machine(remote, 'ssh');
    remoteWindow.local.extensions = undefined;

    const report = await remoteWindow.sync({ initialChoice: 'download' });

    expect(report).toMatchObject({ installed: [], pendingUninstall: [], uploaded: [] });
    expect(JSON.parse(remote.files['extensions.json'])).toEqual(['x.drop', 'x.keep']);
  });

  it('retries on top of a concurrent push', async () => {
    const { remote, a } = await twoMachines();
    a.local.setSettings('{"editor.fontSize": 14, "editor.tabSize": 4}');
    remote.beforeCommit = () => remote.push({ 'extensions.json': '["x.drop", "x.keep", "x.new"]\n' });

    const report = await a.sync();

    expect(report.outcome).toBe('synced');
    expect(a.warnings.some((w) => w.includes('retrying'))).toBe(true);
    expect(parseSettings(remote.files['settings.json'])).toEqual({ 'editor.fontSize': 14, 'editor.tabSize': 4 });
    expect(JSON.parse(remote.files['extensions.json'])).toEqual(['x.drop', 'x.keep', 'x.new']);
    expect(a.local.extensions).toContain('x.new');
  });

  it('skips while settings have unsaved edits', async () => {
    const { a } = await twoMachines();
    a.local.unsaved = true;
    expect((await a.sync()).outcome).toBe('skipped');
  });

  it('refuses to sync a settings file with syntax errors', async () => {
    const { remote, a } = await twoMachines();
    const commits = remote.messages.length;
    a.local.setSettings('{ "editor.fontSize": }');

    await expect(a.sync()).rejects.toThrow(/syntax errors/);
    expect(remote.messages).toHaveLength(commits);
  });
});
