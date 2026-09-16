import { hostname } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { affectsConfig, readConfig, updateConfig, type ZooSyncConfig } from './config';
import type { GitHubAuth } from './github/auth';
import { GitHubApiError, GitHubClient } from './github/client';
import { GitHubRepoStore, parseRepository } from './github/repoStore';
import { VSCodeLocalStore } from './local/vscodeLocalStore';
import { errorMessage, SyncEngine, type SyncReport } from './sync/engine';
import { FileLock } from './sync/lock';
import { buildResourcePlan } from './sync/resources';
import type { InitialSyncChoice } from './sync/ports';
import { FileStateStore } from './sync/stateStore';
import type { StatusBar } from './ui/statusBar';

type Trigger = 'startup' | 'poll' | 'local' | 'auth' | 'manual';

const SETTINGS_SYNC_HINT_KEY = 'zooSync.settingsSyncHintShown';

/** Owns scheduling, change detection and every user interaction around {@link SyncEngine}. */
export class SyncController implements vscode.Disposable {
  private readonly local: VSCodeLocalStore;
  private readonly lock: FileLock;
  private readonly statePath: string;
  private readonly disposables: vscode.Disposable[] = [];
  private timers: NodeJS.Timeout[] = [];
  private watchers: vscode.Disposable[] = [];
  private running = false;
  /** Set by file and extension events; the local timer only syncs when it is set. */
  private dirty = false;
  private pausedUntil = 0;
  private unauthorized = false;
  private ensuredRepository?: string;
  private lastSync?: Date;
  private promptOpen = false;
  private readonly notedProfiles = new Set<string>();
  private readonly markDirty = () => {
    this.dirty = true;
  };
  private initialChoiceDismissed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly auth: GitHubAuth,
    private readonly status: StatusBar,
  ) {
    this.local = new VSCodeLocalStore(context);
    const storage = context.globalStorageUri.fsPath;
    this.lock = new FileLock(path.join(storage, 'sync.lock'));
    this.statePath = path.join(storage, 'state.json');

    this.disposables.push(
      vscode.extensions.onDidChange(this.markDirty),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (affectsConfig(event)) {
          this.reschedule();
          void this.refreshWatchers();
        }
      }),
      auth.onDidChangeSessions(() => void this.run('auth')),
    );
  }

  start(): void {
    this.reschedule();
    void this.refreshWatchers();
    void this.run('startup');
  }

  /**
   * One watcher per synced location. These are OS change notifications, not polling, so watching a
   * handful of files and directories costs effectively nothing.
   */
  private async refreshWatchers(): Promise<void> {
    this.watchers.forEach((watcher) => watcher.dispose());
    this.watchers = [];
    const config = readConfig();
    const plan = buildResourcePlan({ profiles: config.profiles, files: config.files }, this.local.platform);
    const profiles = await this.local.listProfiles().catch(() => []);
    const byName = new Map(profiles.map((profile) => [profile.name, profile]));
    const targets: { dir: string; pattern: string }[] = [];
    for (const name of plan.profiles) {
      const profile = byName.get(name);
      if (profile) {
        targets.push({ dir: profile.dir, pattern: 'settings.json' }, { dir: profile.dir, pattern: 'keybindings.json' });
      }
    }
    for (const pattern of plan.patterns) {
      const dir = pattern.scope === 'home' ? this.local.homeDir : byName.get(pattern.profile ?? '')?.dir;
      if (dir) {
        targets.push({ dir, pattern: pattern.pattern });
      }
    }
    for (const target of targets) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(target.dir), target.pattern),
      );
      this.watchers.push(
        watcher,
        watcher.onDidChange(this.markDirty),
        watcher.onDidCreate(this.markDirty),
        watcher.onDidDelete(this.markDirty),
      );
    }
  }

  dispose(): void {
    this.timers.forEach(clearInterval);
    this.watchers.forEach((watcher) => watcher.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  syncNow(): Promise<void> {
    return this.run('manual');
  }

  async configureRepository(): Promise<void> {
    const session = await this.auth.signIn(this.unauthorized);
    this.unauthorized = false;
    const client = new GitHubClient(session.accessToken);
    const login = await client.getLogin();
    const config = readConfig();
    const value = await vscode.window.showInputBox({
      title: 'Zoo Sync: Sync Repository',
      prompt: 'Private GitHub repository in owner/name form. It is created if it does not exist.',
      value: config.repository || `${login}/vscode-settings`,
      validateInput: (input) => (parseRepository(input) ? undefined : 'Use the form owner/name'),
      ignoreFocusOut: true,
    });
    const target = value === undefined ? undefined : parseRepository(value);
    if (!target) {
      return;
    }
    const repository = `${target.owner}/${target.repo}`;
    const store = new GitHubRepoStore(client, target.owner, target.repo, config.branch);
    const info = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Zoo Sync: preparing ${repository}…` },
      () => store.ensureRepository(),
    );
    if (!info.isPrivate) {
      const answer = await vscode.window.showWarningMessage(
        `${repository} is public, so anyone could read your synced settings.`,
        { modal: true },
        'Use Anyway',
      );
      if (answer !== 'Use Anyway') {
        return;
      }
    }
    await updateConfig('repository', repository);
    this.ensuredRepository = `${repository}@${config.branch}`;
    if (info.created) {
      void vscode.window.showInformationMessage(`Zoo Sync created the private repository ${repository}.`);
    }
    await this.showSettingsSyncHint();
    await this.run('manual');
  }

  async signIn(): Promise<void> {
    try {
      await this.auth.signIn(this.unauthorized);
    } catch (error) {
      this.log.warn(`Sign-in did not complete: ${errorMessage(error)}`);
      return;
    }
    this.unauthorized = false;
    await this.run('manual');
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
    this.status.set({ kind: 'signed-out' });
    void vscode.window.showInformationMessage(
      'Zoo Sync stopped using your GitHub account. To remove the account from VS Code, use the Accounts menu.',
    );
  }

  async toggleAutoSync(): Promise<void> {
    const enabled = !readConfig().autoSync;
    await updateConfig('autoSync', enabled);
    void vscode.window.showInformationMessage(`Zoo Sync: automatic sync ${enabled ? 'enabled' : 'disabled'}.`);
    if (enabled) {
      await this.run('startup');
    }
  }

  async resetLocalState(): Promise<void> {
    if (this.running) {
      void vscode.window.showWarningMessage('Zoo Sync is syncing; try again when it finishes.');
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      'Reset Zoo Sync state on this machine? The next sync asks whether to download, upload or merge.',
      { modal: true },
      'Reset',
    );
    if (answer !== 'Reset') {
      return;
    }
    await new FileStateStore(this.statePath, '', this.local.platform).clear();
    this.initialChoiceDismissed = false;
    void vscode.window.showInformationMessage('Zoo Sync state was reset.');
  }

  /** Lets the user pick which local profiles are synced. */
  async chooseProfiles(): Promise<void> {
    const profiles = await this.local.listProfiles();
    const selected = new Set(readConfig().profiles);
    const picked = await vscode.window.showQuickPick(
      profiles.map((profile) => ({ label: profile.name, picked: selected.has(profile.name) })),
      {
        canPickMany: true,
        title: 'Zoo Sync: Profiles to Sync',
        placeHolder: 'Settings, keybindings, extensions and files are synced per checked profile',
        ignoreFocusOut: true,
      },
    );
    if (!picked) {
      return;
    }
    await updateConfig('profiles', picked.map((item) => item.label));
    await this.run('manual');
  }

  /** Adds the active file, or a path the user types, to zooSync.files. */
  async addFileToSync(): Promise<void> {
    const active = vscode.window.activeTextEditor?.document.uri;
    const suggestion = active && active.scheme === 'file' ? await this.toFileSpec(active.fsPath) : undefined;
    const value = await vscode.window.showInputBox({
      title: 'Zoo Sync: Add File to Sync',
      prompt: 'Path relative to the profile directory (e.g. snippets/**) or under your home directory (e.g. ~/.gitconfig)',
      value: suggestion,
      ignoreFocusOut: true,
    });
    if (!value) {
      return;
    }
    const files = readConfig().files;
    if (files.some((file) => file === value)) {
      return;
    }
    await updateConfig('files', [...files, value]);
    await this.run('manual');
  }

  /** Expresses an absolute path the way zooSync.files wants it, when it lies somewhere we can sync. */
  private async toFileSpec(file: string): Promise<string | undefined> {
    const profiles = await this.local.listProfiles().catch(() => []);
    for (const profile of profiles) {
      const relative = path.relative(profile.dir, file);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative.split(path.sep).join('/');
      }
    }
    const fromHome = path.relative(this.local.homeDir, file);
    if (fromHome && !fromHome.startsWith('..') && !path.isAbsolute(fromHome)) {
      return `~/${fromHome.split(path.sep).join('/')}`;
    }
    return undefined;
  }

  showLog(): void {
    this.log.show();
  }

  private reschedule(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    const config = readConfig();
    if (config.autoSync) {
      this.timers.push(
        setInterval(() => void this.run('poll'), config.remotePollMinutes * 60_000),
        setInterval(() => {
          if (this.dirty) {
            void this.run('local');
          }
        }, config.localSyncMinutes * 60_000),
      );
    }
    if (!this.running) {
      this.setIdle(config);
    }
  }

  private async run(trigger: Trigger, initialChoice?: InitialSyncChoice): Promise<void> {
    const manual = trigger === 'manual';
    const config = readConfig();
    if (this.running) {
      if (manual) {
        void vscode.window.showInformationMessage('Zoo Sync is already syncing.');
      }
      return;
    }
    if (!manual && (!config.autoSync || Date.now() < this.pausedUntil)) {
      return;
    }
    const target = parseRepository(config.repository);
    if (!target) {
      this.status.set({ kind: 'not-configured' });
      if (manual) {
        await this.configureRepository();
      }
      return;
    }
    const session = await this.auth.getSilentSession();
    if (!session) {
      this.status.set({ kind: 'signed-out' });
      if (manual) {
        await this.signIn();
      }
      return;
    }

    this.running = true;
    // Polls only look for remote changes; every other trigger may follow local edits.
    const localChanged = this.dirty || trigger !== 'poll';
    this.dirty = false;
    this.status.set({ kind: 'syncing' });
    try {
      const engine = await this.createEngine(session.accessToken, target, config);
      const result = await this.lock.run(() => engine.sync({ localChanged, initialChoice }));
      if (!result.acquired) {
        this.dirty ||= localChanged;
        this.log.info('Another VS Code window is syncing; skipped this run.');
        this.setIdle(config);
        return;
      }
      this.handleReport(result.value, trigger, config, engine);
    } catch (error) {
      this.dirty ||= localChanged;
      this.ensuredRepository = undefined;
      this.handleError(error, manual);
    } finally {
      this.running = false;
    }
  }

  private async createEngine(
    token: string,
    target: { owner: string; repo: string },
    config: ZooSyncConfig,
  ): Promise<SyncEngine> {
    const store = new GitHubRepoStore(new GitHubClient(token), target.owner, target.repo, config.branch);
    const repositoryKey = `${target.owner}/${target.repo}@${config.branch}`;
    if (this.ensuredRepository !== repositoryKey) {
      await store.ensureRepository();
      this.ensuredRepository = repositoryKey;
    }
    return new SyncEngine({
      local: this.local,
      remote: store,
      state: new FileStateStore(this.statePath, repositoryKey, this.local.platform),
      logger: this.log,
      config: {
        profiles: config.profiles,
        files: config.files,
        ignoredSettings: config.ignoredSettings,
        ignoredExtensions: config.ignoredExtensions,
      },
      machine: `${this.local.platform}@${hostname()}`,
    });
  }

  private handleReport(report: SyncReport, trigger: Trigger, config: ZooSyncConfig, engine: SyncEngine): void {
    const manual = trigger === 'manual';
    this.unauthorized = false;
    this.setIdle(config);
    switch (report.outcome) {
      case 'needs-initial-choice':
        void this.askInitialChoice(manual);
        return;
      case 'skipped':
        this.dirty = true;
        this.log.info(`Sync skipped: ${report.reason}.`);
        if (manual) {
          void vscode.window.showWarningMessage(`Zoo Sync skipped: ${report.reason}.`);
        }
        return;
    }
    this.lastSync = new Date();
    this.setIdle(config);
    const summary = describe(report);
    if (summary) {
      this.log.info(`Sync (${trigger}): ${summary}.`);
    } else {
      this.log.debug(`Sync (${trigger}): up to date.`);
    }
    if (manual) {
      void vscode.window.showInformationMessage(summary ? `Zoo Sync: ${summary}.` : 'Zoo Sync: everything is up to date.');
    }
    for (const problem of report.problems) {
      this.log.warn(problem);
    }
    if (report.missingProfiles.length > 0) {
      this.log.warn(`Configured profiles missing on this machine: ${report.missingProfiles.join(', ')}.`);
    }
    if (report.unconfiguredProfiles.length > 0) {
      this.noteUnconfiguredProfiles(report.unconfiguredProfiles);
    }
    if (report.pendingUninstall.length > 0) {
      void this.offerUninstall(report.pendingUninstall, engine);
    } else if (report.pendingDeletions.length > 0) {
      void this.offerDeletions(report.pendingDeletions, engine);
    }
  }

  private handleError(error: unknown, manual: boolean): void {
    const message = errorMessage(error);
    this.log.error(`Sync failed: ${message}`);
    if (error instanceof GitHubApiError && error.isUnauthorized) {
      this.unauthorized = true;
      this.status.set({ kind: 'signed-out' });
      if (manual) {
        void vscode.window
          .showWarningMessage('Zoo Sync: GitHub rejected the saved token.', 'Sign In')
          .then((action) => action && this.signIn());
      }
      return;
    }
    if (error instanceof GitHubApiError && error.isRateLimited) {
      const seconds = error.retryAfterSeconds ?? 60;
      this.pausedUntil = Date.now() + seconds * 1000;
      this.log.warn(`GitHub rate limit reached; automatic sync pauses for ${Math.ceil(seconds / 60)} minute(s).`);
    }
    this.status.set({ kind: 'error', message });
    if (manual) {
      void vscode.window
        .showErrorMessage(`Zoo Sync: ${message}`, 'Show Log')
        .then((action) => action && this.log.show());
    }
  }

  private async askInitialChoice(explicit: boolean): Promise<void> {
    if (this.promptOpen || (this.initialChoiceDismissed && !explicit)) {
      return;
    }
    this.promptOpen = true;
    let choice: InitialSyncChoice | undefined;
    try {
      const items: (vscode.QuickPickItem & { choice: InitialSyncChoice })[] = [
        {
          label: '$(cloud-download) Download',
          detail: 'Replace settings, keybindings and extensions on this machine with the repository.',
          choice: 'download',
        },
        {
          label: '$(cloud-upload) Upload',
          detail: "Replace the repository with this machine's settings, keybindings and extensions.",
          choice: 'upload',
        },
        {
          label: '$(git-merge) Merge',
          detail: 'Combine both; the repository wins where they differ.',
          choice: 'merge',
        },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Zoo Sync: First Sync on This Machine',
        placeHolder: 'The repository already contains synced data',
        ignoreFocusOut: true,
      });
      choice = picked?.choice;
      this.initialChoiceDismissed = !choice;
    } finally {
      this.promptOpen = false;
    }
    if (choice) {
      await this.run('manual', choice);
    }
  }

  private noteUnconfiguredProfiles(names: string[]): void {
    const fresh = names.filter((name) => !this.notedProfiles.has(name));
    if (fresh.length === 0) {
      return;
    }
    fresh.forEach((name) => this.notedProfiles.add(name));
    void vscode.window
      .showInformationMessage(
        `The repository also holds profile(s) ${fresh.join(', ')}. Add them to zooSync.profiles to sync them here.`,
        'Choose Profiles',
      )
      .then((action) => action && this.chooseProfiles());
  }

  private async offerDeletions(paths: string[], engine: SyncEngine): Promise<void> {
    if (this.promptOpen) {
      return;
    }
    this.promptOpen = true;
    try {
      const message =
        paths.length === 1
          ? `${paths[0]} was deleted on another machine.`
          : `${paths.length} synced files were deleted on another machine.`;
      const action = await vscode.window.showInformationMessage(message, 'Review…', 'Keep on This Machine');
      let chosen: string[] | undefined;
      if (action === 'Keep on This Machine') {
        chosen = [];
      } else if (action === 'Review…') {
        const picked = await vscode.window.showQuickPick(
          paths.map((path) => ({ label: path, picked: true })),
          {
            canPickMany: true,
            title: 'Zoo Sync: Delete Files Removed Elsewhere',
            placeHolder: 'Checked files are deleted (a copy is kept); unchecked ones stay here without syncing',
            ignoreFocusOut: true,
          },
        );
        chosen = picked?.map((item) => item.label);
      }
      if (!chosen) {
        return;
      }
      const selection = chosen;
      const result = await this.lock.run(() => engine.resolvePendingDeletions(selection));
      if (!result.acquired) {
        void vscode.window.showWarningMessage('Zoo Sync is busy in another window; you will be asked again later.');
      }
    } finally {
      this.promptOpen = false;
    }
  }

  private async offerUninstall(ids: string[], engine: SyncEngine): Promise<void> {
    if (this.promptOpen) {
      return;
    }
    this.promptOpen = true;
    try {
      const message =
        ids.length === 1
          ? `Extension ${ids[0]} was removed on another machine.`
          : `${ids.length} extensions were removed on another machine.`;
      const action = await vscode.window.showInformationMessage(message, 'Review…', 'Keep on This Machine');
      let chosen: string[] | undefined;
      if (action === 'Keep on This Machine') {
        chosen = [];
      } else if (action === 'Review…') {
        const picked = await vscode.window.showQuickPick(
          ids.map((id) => ({ label: id, picked: true })),
          {
            canPickMany: true,
            title: 'Zoo Sync: Uninstall Extensions Removed Elsewhere',
            placeHolder: 'Checked extensions are uninstalled; unchecked ones stay on this machine without syncing',
            ignoreFocusOut: true,
          },
        );
        chosen = picked?.map((item) => item.label);
      }
      if (!chosen) {
        return;
      }
      const selection = chosen;
      const profile = (await this.local.currentProfile()) ?? 'Default';
      const result = await this.lock.run(() => engine.resolvePendingUninstall(profile, selection));
      if (!result.acquired) {
        void vscode.window.showWarningMessage('Zoo Sync is busy in another window; you will be asked again later.');
      }
    } finally {
      this.promptOpen = false;
    }
  }

  private async showSettingsSyncHint(): Promise<void> {
    if (this.context.globalState.get<boolean>(SETTINGS_SYNC_HINT_KEY)) {
      return;
    }
    await this.context.globalState.update(SETTINGS_SYNC_HINT_KEY, true);
    void vscode.window.showInformationMessage(
      "If VS Code's built-in Settings Sync is on, turn it off so it and Zoo Sync don't overwrite each other.",
    );
  }

  private setIdle(config: ZooSyncConfig): void {
    this.status.set(
      parseRepository(config.repository)
        ? { kind: 'idle', autoSync: config.autoSync, lastSync: this.lastSync }
        : { kind: 'not-configured' },
    );
  }
}

function describe(report: SyncReport): string {
  const parts: string[] = [];
  if (report.migrated) {
    parts.push('moved the repository to the profile layout');
  }
  if (report.uploaded.length > 0) {
    parts.push(`uploaded ${summarize(report.uploaded)}`);
  }
  if (report.removed.length > 0) {
    parts.push(`removed ${summarize(report.removed)} from the repository`);
  }
  if (report.applied.length > 0) {
    parts.push(`applied ${summarize(report.applied.map((file) => path.basename(file)))}`);
  }
  if (report.installed.length > 0) {
    parts.push(`installed ${report.installed.length} extension(s)`);
  }
  if (report.conflicts.length > 0) {
    parts.push(`resolved ${report.conflicts.length} conflict(s)`);
  }
  return parts.join('; ');
}

/** Long lists make for unreadable notifications, so only the first few names are shown. */
function summarize(names: readonly string[]): string {
  const shown = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${shown} and ${names.length - 2} more` : shown;
}
