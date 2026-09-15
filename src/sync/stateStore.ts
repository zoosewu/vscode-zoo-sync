import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { emptyState, type LocalState, type StateStore } from './ports';

interface StateFile extends LocalState {
  version: 1;
  repository: string;
}

/**
 * Sync state in a JSON file under global storage. Every VS Code window reads it fresh,
 * unlike `globalState`, whose cached values can lag behind other windows.
 */
export class FileStateStore implements StateStore {
  /** @param repository `owner/name@branch`; state recorded for another repository is ignored. */
  constructor(
    private readonly file: string,
    private readonly repository: string,
  ) {}

  async read(): Promise<LocalState> {
    let data: Partial<StateFile>;
    try {
      data = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StateFile>;
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyState();
      }
      throw error;
    }
    if (data.repository !== this.repository) {
      return emptyState();
    }
    return {
      base: data.base,
      localOnlyExtensions: data.localOnlyExtensions ?? [],
      pendingUninstall: data.pendingUninstall ?? [],
      unavailableExtensions: data.unavailableExtensions ?? [],
    };
  }

  async write(state: LocalState): Promise<void> {
    const content: StateFile = { version: 1, repository: this.repository, ...state };
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(content, null, 2));
    await rename(temp, this.file);
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
