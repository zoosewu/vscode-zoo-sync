import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Directories that never hold synced files and can be large. */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

/**
 * Relative paths under `dir` that `matches` accepts. Unreadable directories are ignored, and symlinks
 * are never followed: they can lead outside the directory the user asked to sync.
 */
export async function listMatchingFiles(
  dir: string,
  matches: (relativePath: string) => boolean,
  limit: number,
): Promise<string[]> {
  const found: string[] = [];

  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit || entry.isSymbolicLink()) {
        continue;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          await walk(join(current, entry.name), relative);
        }
      } else if (entry.isFile() && matches(relative)) {
        found.push(relative);
      }
    }
  };

  await walk(dir, '');
  return found.sort();
}
