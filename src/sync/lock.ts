import { mkdir, open, rm, stat, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Cross-window mutex backed by an exclusively created file. The holder refreshes the file's mtime,
 * so a lock left behind by a crashed window expires after `staleMs`.
 */
export class FileLock {
  constructor(
    private readonly file: string,
    private readonly staleMs = 120_000,
    private readonly heartbeatMs = 30_000,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<LockResult<T>> {
    if (!(await this.acquire())) {
      return { acquired: false };
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      utimes(this.file, now, now).catch(() => undefined);
    }, this.heartbeatMs);
    try {
      return { acquired: true, value: await task() };
    } finally {
      clearInterval(heartbeat);
      await rm(this.file, { force: true });
    }
  }

  private async acquire(): Promise<boolean> {
    await mkdir(dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.file, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        const info = await stat(this.file).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs < this.staleMs) {
          return false;
        }
        await rm(this.file, { force: true });
      }
    }
    return false;
  }
}
