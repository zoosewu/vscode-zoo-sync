import * as vscode from 'vscode';
import { GitHubAuth } from './github/auth';
import { errorMessage } from './sync/engine';
import { SyncController } from './syncController';
import { StatusBar } from './ui/statusBar';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Zoo Sync', { log: true });
  const status = new StatusBar();
  const controller = new SyncController(context, log, new GitHubAuth(context.globalState), status);
  context.subscriptions.push(log, status, controller);

  const commands: Record<string, () => unknown> = {
    'zooSync.configureRepository': () => controller.configureRepository(),
    'zooSync.syncNow': () => controller.syncNow(),
    'zooSync.signIn': () => controller.signIn(),
    'zooSync.signOut': () => controller.signOut(),
    'zooSync.showLog': () => controller.showLog(),
    'zooSync.toggleAutoSync': () => controller.toggleAutoSync(),
    'zooSync.resetLocalState': () => controller.resetLocalState(),
  };
  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await handler();
        } catch (error) {
          log.error(`${id} failed: ${errorMessage(error)}`);
          void vscode.window.showErrorMessage(`Zoo Sync: ${errorMessage(error)}`);
        }
      }),
    );
  }

  controller.start();
}
