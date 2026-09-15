import { jsonEquals, own } from './canonical';
import type { JsonObject } from './types';

export type ConflictWinner = 'local' | 'remote';

export interface MergedValue<T> {
  value: T | undefined;
  conflict: boolean;
}

/**
 * Three-way merge of a single value. `undefined` means absent.
 * One-sided changes win; when both sides changed to different values, `onConflict` decides.
 */
export function mergeValue<T>(
  base: T | undefined,
  local: T | undefined,
  remote: T | undefined,
  onConflict: ConflictWinner,
): MergedValue<T> {
  if (jsonEquals(local, remote)) {
    return { value: local, conflict: false };
  }
  if (jsonEquals(local, base)) {
    return { value: remote, conflict: false };
  }
  if (jsonEquals(remote, base)) {
    return { value: local, conflict: false };
  }
  return { value: onConflict === 'local' ? local : remote, conflict: true };
}

/**
 * Per top-level key three-way merge of settings.
 * A missing remote document is treated as unchanged from base, so a deleted file never wipes settings.
 */
export function mergeSettings(
  base: JsonObject | undefined,
  local: JsonObject,
  remote: JsonObject | undefined,
  onConflict: ConflictWinner,
): { merged: JsonObject; conflicts: string[] } {
  const baseDoc = base ?? {};
  const remoteDoc = remote ?? baseDoc;
  const keys = new Set([...Object.keys(baseDoc), ...Object.keys(local), ...Object.keys(remoteDoc)]);
  const entries: [string, JsonObject[string]][] = [];
  const conflicts: string[] = [];
  for (const key of keys) {
    const result = mergeValue(own(baseDoc, key), own(local, key), own(remoteDoc, key), onConflict);
    if (result.conflict) {
      conflicts.push(key);
    }
    if (result.value !== undefined) {
      entries.push([key, result.value]);
    }
  }
  return { merged: Object.fromEntries(entries), conflicts };
}

/** Whole-document three-way merge of canonical keybindings. */
export function mergeKeybindings(
  base: string | undefined,
  local: string,
  remote: string | undefined,
  onConflict: ConflictWinner,
): { merged: string; conflict: boolean } {
  const result = mergeValue(base, local, remote ?? base, onConflict);
  return { merged: result.value ?? local, conflict: result.conflict };
}

/** Three-way set merge: additions and removals from either side are all kept. Never conflicts. */
export function mergeExtensions(base: string[] | undefined, local: string[], remote: string[] | undefined): string[] {
  const baseSet = new Set(base ?? []);
  const localSet = new Set(local);
  const remoteSet = new Set(remote ?? base ?? []);
  const result = new Set([...baseSet].filter((id) => localSet.has(id) && remoteSet.has(id)));
  for (const id of [...localSet, ...remoteSet]) {
    if (!baseSet.has(id)) {
      result.add(id);
    }
  }
  return [...result].sort();
}
