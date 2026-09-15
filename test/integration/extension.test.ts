import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Zoo Sync extension', () => {
  test('activates and registers its commands', async () => {
    const extension = vscode.extensions.getExtension('zoosewu.zoo-sync');
    assert.ok(extension, 'extension is installed in the test host');
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'zooSync.configureRepository',
      'zooSync.syncNow',
      'zooSync.signIn',
      'zooSync.signOut',
      'zooSync.showLog',
      'zooSync.toggleAutoSync',
      'zooSync.resetLocalState',
    ]) {
      assert.ok(commands.includes(id), `${id} is registered`);
    }
  });
});
