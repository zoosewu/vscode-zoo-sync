import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listMatchingFiles } from '../../src/local/walk';
import { globToPathRegExp } from '../../src/sync/pathSpec';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoo-walk-'));
  await mkdir(join(dir, 'snippets/lang'), { recursive: true });
  await mkdir(join(dir, '.git'), { recursive: true });
  await mkdir(join(dir, 'node_modules/pkg'), { recursive: true });
  await writeFile(join(dir, '.gitconfig'), 'x');
  await writeFile(join(dir, 'snippets/py.json'), 'x');
  await writeFile(join(dir, 'snippets/lang/go.json'), 'x');
  await writeFile(join(dir, '.git/config'), 'x');
  await writeFile(join(dir, 'node_modules/pkg/index.js'), 'x');
});

const matcher = (pattern: string) => {
  const regexp = globToPathRegExp(pattern);
  return (relativePath: string) => regexp.test(relativePath);
};

describe('listMatchingFiles', () => {
  it('includes dot files such as .gitconfig', async () => {
    expect(await listMatchingFiles(dir, matcher('.gitconfig'), 10)).toEqual(['.gitconfig']);
  });

  it('walks nested directories for ** patterns', async () => {
    expect(await listMatchingFiles(dir, matcher('snippets/**'), 10)).toEqual([
      'snippets/lang/go.json',
      'snippets/py.json',
    ]);
  });

  it('never descends into .git or node_modules', async () => {
    expect(await listMatchingFiles(dir, () => true, 50)).toEqual(['.gitconfig', 'snippets/lang/go.json', 'snippets/py.json']);
  });

  it('skips symlinks and stops at the limit', async () => {
    await symlink(join(dir, 'snippets/py.json'), join(dir, 'snippets/link.json'));
    expect(await listMatchingFiles(dir, matcher('snippets/*.json'), 10)).toEqual(['snippets/py.json']);
    expect(await listMatchingFiles(dir, () => true, 1)).toHaveLength(1);
  });

  it('returns nothing for a missing directory', async () => {
    expect(await listMatchingFiles(join(dir, 'nope'), () => true, 10)).toEqual([]);
  });
});
