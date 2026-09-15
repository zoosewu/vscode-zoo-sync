export const GITHUB_API_VERSION = '2026-03-10';

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds to wait before retrying, when GitHub reports rate limiting. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }

  get isRateLimited(): boolean {
    return this.status === 429 || (this.status === 403 && this.retryAfterSeconds !== undefined);
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export interface RequestOptions {
  body?: unknown;
  accept?: string;
  headers?: Record<string, string>;
  /** Non-2xx statuses returned to the caller instead of thrown. */
  allow?: number[];
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.github.com',
  ) {}

  /** Returns 2xx, 304 and allowed responses; throws {@link GitHubApiError} for anything else. */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: options.accept ?? 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'User-Agent': 'zoo-sync-vscode',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...options.headers,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (response.ok || response.status === 304 || options.allow?.includes(response.status)) {
      return response;
    }
    throw await toApiError(response);
  }

  async json<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
    const response = await this.request(method, path, options);
    return (await response.json()) as T;
  }

  async getLogin(): Promise<string> {
    return (await this.json<{ login: string }>('GET', '/user')).login;
  }
}

export async function toApiError(response: Response): Promise<GitHubApiError> {
  let message = response.statusText;
  try {
    const body = (await response.json()) as { message?: string };
    message = body.message ?? message;
  } catch {
    // Body is not JSON; keep the status text.
  }
  const retryAfter = response.headers.get('retry-after');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = response.headers.get('x-ratelimit-reset');
  let retryAfterSeconds: number | undefined;
  if (retryAfter !== null) {
    retryAfterSeconds = Number(retryAfter);
  } else if (remaining === '0' && reset !== null) {
    retryAfterSeconds = Math.max(0, Number(reset) - Math.floor(Date.now() / 1000));
  }
  return new GitHubApiError(response.status, `GitHub API ${response.status}: ${message}`, retryAfterSeconds);
}
