import * as vscode from 'vscode';

const PROVIDER_ID = 'github';
/** `repo` is the narrowest OAuth scope that can read and write private repositories. */
const SCOPES = ['repo'];
const SIGNED_OUT_KEY = 'zooSync.signedOut';

export class GitHubAuth {
  constructor(private readonly memento: vscode.Memento) {}

  /** Existing session without prompting; `undefined` when there is none or the user signed out of Zoo Sync. */
  async getSilentSession(): Promise<vscode.AuthenticationSession | undefined> {
    if (this.memento.get<boolean>(SIGNED_OUT_KEY, false)) {
      return undefined;
    }
    return vscode.authentication.getSession(PROVIDER_ID, SCOPES, { silent: true });
  }

  /** Prompts for sign-in when needed. `forceNew` replaces a token GitHub rejected. */
  async signIn(forceNew = false): Promise<vscode.AuthenticationSession> {
    await this.memento.update(SIGNED_OUT_KEY, false);
    if (forceNew) {
      return vscode.authentication.getSession(PROVIDER_ID, SCOPES, {
        forceNewSession: { detail: 'GitHub rejected the previous token.' },
      });
    }
    return vscode.authentication.getSession(PROVIDER_ID, SCOPES, { createIfNone: true });
  }

  /** Extensions cannot remove accounts, so Zoo Sync just stops using the session. */
  async signOut(): Promise<void> {
    await this.memento.update(SIGNED_OUT_KEY, true);
  }

  onDidChangeSessions(listener: () => void): vscode.Disposable {
    return vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === PROVIDER_ID) {
        listener();
      }
    });
  }
}
