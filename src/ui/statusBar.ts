import * as vscode from 'vscode';

export type SyncStatus =
  | { kind: 'idle'; autoSync: boolean; lastSync?: Date }
  | { kind: 'syncing' }
  | { kind: 'error'; message: string }
  | { kind: 'signed-out' }
  | { kind: 'not-configured' };

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('zooSync.status', vscode.StatusBarAlignment.Left);

  constructor() {
    this.item.name = 'Zoo Sync';
    this.set({ kind: 'not-configured' });
    this.item.show();
  }

  set(status: SyncStatus): void {
    const item = this.item;
    item.backgroundColor = undefined;
    switch (status.kind) {
      case 'idle':
        item.text = status.autoSync ? '$(check) Zoo Sync' : '$(circle-slash) Zoo Sync';
        item.tooltip = [
          status.lastSync ? `Last synced ${status.lastSync.toLocaleString()}` : 'Not synced yet in this window',
          `Auto sync is ${status.autoSync ? 'on' : 'off'}`,
          'Click to sync now',
        ].join('\n');
        item.command = 'zooSync.syncNow';
        break;
      case 'syncing':
        item.text = '$(sync~spin) Zoo Sync';
        item.tooltip = 'Syncing…';
        item.command = undefined;
        break;
      case 'error':
        item.text = '$(warning) Zoo Sync';
        item.tooltip = `Last sync failed: ${status.message}\nClick to show the log`;
        item.command = 'zooSync.showLog';
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'signed-out':
        item.text = '$(account) Zoo Sync';
        item.tooltip = 'Sign in with GitHub to sync';
        item.command = 'zooSync.signIn';
        break;
      case 'not-configured':
        item.text = '$(gear) Zoo Sync';
        item.tooltip = 'Choose a GitHub repository to sync with';
        item.command = 'zooSync.configureRepository';
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
