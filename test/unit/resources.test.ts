import { describe, expect, it } from 'vitest';
import { buildResourcePlan, relativeFromRemote, remotePathFor } from '../../src/sync/resources';

describe('buildResourcePlan', () => {
  it('creates the built-in resources for every profile', () => {
    const plan = buildResourcePlan({ profiles: ['Default', 'Work'], files: [] }, 'linux');
    expect(plan.builtins.map((b) => b.remotePath)).toEqual([
      'profiles/Default/settings.json',
      'profiles/Default/keybindings/linux.json',
      'profiles/Default/extensions.json',
      'profiles/Work/settings.json',
      'profiles/Work/keybindings/linux.json',
      'profiles/Work/extensions.json',
    ]);
  });

  it('expands profile-scoped files per profile and home files once', () => {
    const plan = buildResourcePlan(
      { profiles: ['Default', 'Work'], files: ['snippets/**', '~/.gitconfig'] },
      'macos',
    );
    expect(plan.patterns.map((p) => p.remotePrefix)).toEqual([
      'profiles/Default/files/common',
      'profiles/Work/files/common',
      'files/common',
    ]);
  });

  it('puts per-platform files in their own directory', () => {
    const plan = buildResourcePlan(
      { profiles: ['Default'], files: [{ path: '~/.config/x.toml', perPlatform: true }] },
      'windows',
    );
    expect(plan.patterns[0].remotePrefix).toBe('files/windows');
  });

  it('reports bad entries instead of throwing', () => {
    const plan = buildResourcePlan({ profiles: ['Default', 'a/b', ' '], files: ['/etc/hosts', 'ok.json'] }, 'linux');
    expect(plan.profiles).toEqual(['Default']);
    expect(plan.problems).toHaveLength(3);
    expect(plan.patterns).toHaveLength(1);
  });

  it('falls back to the Default profile when none are configured', () => {
    expect(buildResourcePlan({ profiles: [], files: [] }, 'linux').profiles).toEqual(['Default']);
  });

  it('maps between relative and remote paths', () => {
    const [pattern] = buildResourcePlan({ profiles: ['Default'], files: ['snippets/**'] }, 'linux').patterns;
    expect(remotePathFor(pattern, 'snippets/py.json')).toBe('profiles/Default/files/common/snippets/py.json');
    expect(relativeFromRemote(pattern, 'profiles/Default/files/common/snippets/py.json')).toBe('snippets/py.json');
    expect(relativeFromRemote(pattern, 'files/common/snippets/py.json')).toBeUndefined();
    expect(pattern.matches('snippets/py.json')).toBe(true);
    expect(pattern.matches('tasks.json')).toBe(false);
  });
});
