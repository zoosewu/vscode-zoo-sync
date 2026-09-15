import { describe, expect, it } from 'vitest';
import { GITHUB_API_VERSION, GitHubApiError, GitHubClient } from '../../src/github/client';
import { GitHubRepoStore, parseRepository } from '../../src/github/repoStore';
import { NonFastForwardError } from '../../src/sync/ports';

interface Step {
  method: string;
  path: string;
  response: Response;
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

function scripted(steps: Step[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const step = steps.shift();
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({
      method,
      url,
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (!step) {
      throw new Error(`Unexpected request ${method} ${url}`);
    }
    expect(`${method} ${url}`).toBe(`${step.method} https://api.github.com${step.path}`);
    return step.response;
  }) as typeof fetch;
  const store = new GitHubRepoStore(new GitHubClient('token', fetchImpl), 'me', 'sync', 'main');
  return { calls, fetchImpl, store, remaining: steps };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const text = (status: number, body: string | null) => new Response(body, { status });

describe('GitHubClient', () => {
  it('sends auth, version and user-agent headers', async () => {
    const { calls, fetchImpl } = scripted([{ method: 'GET', path: '/user', response: json(200, { login: 'me' }) }]);
    expect(await new GitHubClient('token', fetchImpl).getLogin()).toBe('me');
    expect(calls[0].headers).toMatchObject({
      Authorization: 'Bearer token',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'zoo-sync-vscode',
      Accept: 'application/vnd.github+json',
    });
  });

  it('reports rate limiting with a retry delay', async () => {
    const { fetchImpl } = scripted([
      { method: 'GET', path: '/user', response: json(429, { message: 'slow down' }, { 'retry-after': '30' }) },
    ]);
    const error = await new GitHubClient('token', fetchImpl).getLogin().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).isRateLimited).toBe(true);
    expect((error as GitHubApiError).retryAfterSeconds).toBe(30);
  });

  it('derives the delay from x-ratelimit-reset on a 403', async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const { fetchImpl } = scripted([
      {
        method: 'GET',
        path: '/user',
        response: json(403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
      },
    ]);
    const error = (await new GitHubClient('token', fetchImpl).getLogin().catch((e: unknown) => e)) as GitHubApiError;
    expect(error.isRateLimited).toBe(true);
    expect(error.retryAfterSeconds).toBeGreaterThan(100);
  });
});

describe('GitHubRepoStore', () => {
  it('uses the sha as ETag and treats 304 as unchanged', async () => {
    const { store, calls } = scripted([
      { method: 'GET', path: '/repos/me/sync/commits/main', response: text(304, null) },
      { method: 'GET', path: '/repos/me/sync/commits/main', response: text(200, 'def456\n') },
    ]);
    expect(await store.getHead('abc123')).toBeUndefined();
    expect(calls[0].headers).toMatchObject({ 'If-None-Match': '"abc123"', Accept: 'application/vnd.github.sha' });
    expect(await store.getHead()).toBe('def456');
  });

  it('reads raw files pinned to a commit and maps 404 to undefined', async () => {
    const { store } = scripted([
      { method: 'GET', path: '/repos/me/sync/contents/keybindings/linux.json?ref=c1', response: text(200, '[]') },
      { method: 'GET', path: '/repos/me/sync/contents/settings.json?ref=c1', response: json(404, { message: 'Not Found' }) },
    ]);
    expect(await store.readFile('c1', 'keybindings/linux.json')).toBe('[]');
    expect(await store.readFile('c1', 'settings.json')).toBeUndefined();
  });

  it('commits all files atomically and fast-forwards without force', async () => {
    const { store, calls, remaining } = scripted([
      { method: 'GET', path: '/repos/me/sync/git/commits/p1', response: json(200, { tree: { sha: 't0' } }) },
      { method: 'POST', path: '/repos/me/sync/git/trees', response: json(201, { sha: 't1' }) },
      { method: 'POST', path: '/repos/me/sync/git/commits', response: json(201, { sha: 'c2' }) },
      { method: 'PATCH', path: '/repos/me/sync/git/refs/heads/main', response: json(200, {}) },
    ]);

    expect(await store.commit('p1', { 'settings.json': '{}', 'meta.json': '{}' }, 'sync: settings')).toBe('c2');

    expect(remaining).toHaveLength(0);
    expect(calls[1].body).toEqual({
      base_tree: 't0',
      tree: [
        { path: 'settings.json', mode: '100644', type: 'blob', content: '{}' },
        { path: 'meta.json', mode: '100644', type: 'blob', content: '{}' },
      ],
    });
    expect(calls[2].body).toEqual({ message: 'sync: settings', tree: 't1', parents: ['p1'] });
    expect(calls[3].body).toEqual({ sha: 'c2', force: false });
  });

  it('turns a non-fast-forward ref update into NonFastForwardError', async () => {
    const { store } = scripted([
      { method: 'GET', path: '/repos/me/sync/git/commits/p1', response: json(200, { tree: { sha: 't0' } }) },
      { method: 'POST', path: '/repos/me/sync/git/trees', response: json(201, { sha: 't1' }) },
      { method: 'POST', path: '/repos/me/sync/git/commits', response: json(201, { sha: 'c2' }) },
      {
        method: 'PATCH',
        path: '/repos/me/sync/git/refs/heads/main',
        response: json(422, { message: 'Update is not a fast forward' }),
      },
    ]);
    await expect(store.commit('p1', {}, 'm')).rejects.toBeInstanceOf(NonFastForwardError);
  });

  it('creates a missing repository as private for the signed-in user', async () => {
    const { store, calls } = scripted([
      { method: 'GET', path: '/repos/me/sync', response: json(404, { message: 'Not Found' }) },
      { method: 'GET', path: '/user', response: json(200, { login: 'Me' }) },
      { method: 'POST', path: '/user/repos', response: json(201, { private: true, default_branch: 'main' }) },
      { method: 'GET', path: '/repos/me/sync/git/ref/heads/main', response: json(200, { object: { sha: 'x' } }) },
    ]);
    expect(await store.ensureRepository()).toEqual({ created: true, isPrivate: true });
    expect(calls[2].body).toMatchObject({ name: 'sync', private: true, auto_init: true });
  });

  it('refuses to create repositories for other owners', async () => {
    const { store } = scripted([
      { method: 'GET', path: '/repos/me/sync', response: json(404, { message: 'Not Found' }) },
      { method: 'GET', path: '/user', response: json(200, { login: 'someone-else' }) },
    ]);
    await expect(store.ensureRepository()).rejects.toThrow(/only create repositories under your own account/);
  });

  it('initializes an empty repository with meta.json', async () => {
    const { store, calls } = scripted([
      { method: 'GET', path: '/repos/me/sync', response: json(200, { private: true, default_branch: 'main' }) },
      { method: 'GET', path: '/repos/me/sync/git/ref/heads/main', response: json(409, { message: 'Git Repository is empty.' }) },
      { method: 'PUT', path: '/repos/me/sync/contents/meta.json', response: json(201, {}) },
    ]);
    expect(await store.ensureRepository()).toEqual({ created: false, isPrivate: true });
    expect(calls[2].body).toMatchObject({ branch: 'main', message: 'Initialize Zoo Sync' });
  });

  it('creates a missing branch from the default branch', async () => {
    const steps: Step[] = [
      { method: 'GET', path: '/repos/me/sync', response: json(200, { private: true, default_branch: 'trunk' }) },
      { method: 'GET', path: '/repos/me/sync/git/ref/heads/main', response: json(404, { message: 'Not Found' }) },
      { method: 'GET', path: '/repos/me/sync/git/ref/heads/trunk', response: json(200, { object: { sha: 'm1' } }) },
      { method: 'POST', path: '/repos/me/sync/git/refs', response: json(201, {}) },
    ];
    const { store, calls } = scripted(steps);
    await store.ensureRepository();
    expect(calls[3].body).toEqual({ ref: 'refs/heads/main', sha: 'm1' });
  });
});

describe('parseRepository', () => {
  it('accepts owner/name only', () => {
    expect(parseRepository(' me/vscode-settings ')).toEqual({ owner: 'me', repo: 'vscode-settings' });
    expect(parseRepository('https://github.com/me/x')).toBeUndefined();
    expect(parseRepository('me')).toBeUndefined();
  });
});
