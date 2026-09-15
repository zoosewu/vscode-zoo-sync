import { emptyMeta, serializeMeta } from '../sync/documents';
import { NonFastForwardError, type RemoteStore } from '../sync/ports';
import { toApiError, type GitHubClient } from './client';

/** Parses `owner/name`. */
export function parseRepository(value: string): { owner: string; repo: string } | undefined {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value.trim());
  return match ? { owner: match[1], repo: match[2] } : undefined;
}

export interface RepositoryInfo {
  created: boolean;
  isPrivate: boolean;
}

/** Sync storage on one branch of a GitHub repository, written through the Git Database API. */
export class GitHubRepoStore implements RemoteStore {
  private readonly repoPath: string;
  private readonly branchPath: string;

  constructor(
    private readonly client: GitHubClient,
    readonly owner: string,
    readonly repo: string,
    readonly branch: string,
  ) {
    this.repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    this.branchPath = encodePath(branch);
  }

  /**
   * Makes sure the repository and branch exist. A missing repository is created as private
   * when it belongs to the signed-in user.
   */
  async ensureRepository(): Promise<RepositoryInfo> {
    const response = await this.client.request('GET', this.repoPath, { allow: [404] });
    let info: { private: boolean; default_branch: string };
    let created = false;
    if (response.status === 404) {
      const login = await this.client.getLogin();
      if (login.toLowerCase() !== this.owner.toLowerCase()) {
        throw new Error(
          `Repository ${this.owner}/${this.repo} was not found or is not accessible. ` +
            `Zoo Sync can only create repositories under your own account (${login}).`,
        );
      }
      info = await this.client.json('POST', '/user/repos', {
        body: {
          name: this.repo,
          private: true,
          auto_init: true,
          description: 'VS Code settings, keybindings and extensions synced by Zoo Sync',
        },
      });
      created = true;
    } else {
      info = (await response.json()) as typeof info;
    }
    await this.ensureBranch(info.default_branch);
    return { created, isPrivate: info.private };
  }

  private async ensureBranch(defaultBranch: string): Promise<void> {
    const ref = await this.client.request('GET', `${this.repoPath}/git/ref/heads/${this.branchPath}`, {
      allow: [404, 409],
    });
    if (ref.ok) {
      return;
    }
    if (ref.status === 409) {
      // Empty repository: the Git Database API refuses to work until a first commit exists.
      await this.client.request('PUT', `${this.repoPath}/contents/meta.json`, {
        body: {
          message: 'Initialize Zoo Sync',
          content: Buffer.from(serializeMeta(emptyMeta()), 'utf8').toString('base64'),
          branch: this.branch,
        },
      });
      return;
    }
    const base = await this.client.json<{ object: { sha: string } }>(
      'GET',
      `${this.repoPath}/git/ref/heads/${encodePath(defaultBranch)}`,
    );
    await this.client.request('POST', `${this.repoPath}/git/refs`, {
      body: { ref: `refs/heads/${this.branch}`, sha: base.object.sha },
    });
  }

  async getHead(knownSha?: string): Promise<string | undefined> {
    const response = await this.client.request('GET', `${this.repoPath}/commits/${this.branchPath}`, {
      accept: 'application/vnd.github.sha',
      headers: knownSha ? { 'If-None-Match': `"${knownSha}"` } : undefined,
    });
    if (response.status === 304) {
      return undefined;
    }
    return (await response.text()).trim();
  }

  async readFile(commitSha: string, path: string): Promise<string | undefined> {
    const response = await this.client.request('GET', `${this.repoPath}/contents/${encodePath(path)}?ref=${commitSha}`, {
      accept: 'application/vnd.github.raw+json',
      allow: [404],
    });
    return response.status === 404 ? undefined : await response.text();
  }

  async commit(parentSha: string, files: Record<string, string>, message: string): Promise<string> {
    const parent = await this.client.json<{ tree: { sha: string } }>('GET', `${this.repoPath}/git/commits/${parentSha}`);
    const tree = await this.client.json<{ sha: string }>('POST', `${this.repoPath}/git/trees`, {
      body: {
        base_tree: parent.tree.sha,
        tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
      },
    });
    const commit = await this.client.json<{ sha: string }>('POST', `${this.repoPath}/git/commits`, {
      body: { message, tree: tree.sha, parents: [parentSha] },
    });
    const update = await this.client.request('PATCH', `${this.repoPath}/git/refs/heads/${this.branchPath}`, {
      body: { sha: commit.sha, force: false },
      allow: [422],
    });
    if (update.status === 422) {
      const error = await toApiError(update);
      if (/fast.?forward/i.test(error.message)) {
        throw new NonFastForwardError();
      }
      throw error;
    }
    return commit.sha;
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
