import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser';
import { canonicalize, jsonEquals, own, parseJsonc } from './canonical';
import type { JsonObject, JsonValue, RemoteMeta } from './types';

export function parseSettings(text: string | undefined, source = 'settings.json'): JsonObject {
  const value = text === undefined ? undefined : parseJsonc(text, source);
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  return value as JsonObject;
}

export function omitKeys(settings: JsonObject, shouldOmit: (key: string) => boolean): JsonObject {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !shouldOmit(key)));
}

/** Rewrites only the keys whose values differ between `from` and `to`, keeping comments and formatting. */
export function applySettingsChanges(text: string, from: JsonObject, to: JsonObject): string {
  const changed = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter(
    (key) => !jsonEquals(own(from, key), own(to, key)),
  );
  return setKeys(text, changed.map((key) => [key, own(to, key)]));
}

export function removeSettings(text: string, keys: readonly string[]): string {
  return setKeys(text, keys.map((key) => [key, undefined]));
}

function setKeys(text: string, entries: [string, JsonValue | undefined][]): string {
  if (entries.length === 0) {
    return text;
  }
  const formattingOptions = detectFormatting(text);
  let result = text.trim() === '' ? '{}' : text;
  for (const [key, value] of entries) {
    result = applyEdits(result, modify(result, [key], value, { formattingOptions }));
  }
  return result;
}

function detectFormatting(text: string): FormattingOptions {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  const insertSpaces = !indent?.startsWith('\t');
  return {
    insertSpaces,
    tabSize: insertSpaces && indent ? indent.length : 4,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

/** Canonical form of a keybindings file. A missing or blank file is an empty array. */
export function canonicalKeybindings(text: string | undefined, source = 'keybindings.json'): string {
  const value = text === undefined ? undefined : parseJsonc(text, source);
  if (value === undefined) {
    return '[]';
  }
  if (!Array.isArray(value)) {
    throw new Error(`${source} must contain a JSON array`);
  }
  return canonicalize(value);
}

/** Lower-cased, de-duplicated, sorted extension ids. Versions are never part of the id. */
export function normalizeExtensionIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].map((id) => id.trim().toLowerCase()).filter(Boolean))].sort();
}

export function parseExtensionList(text: string): string[] {
  const value = parseJsonc(text, 'extensions.json');
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new Error('extensions.json must contain an array of extension ids');
  }
  return normalizeExtensionIds(value as string[]);
}

export function serializeExtensionList(ids: readonly string[]): string {
  return `${JSON.stringify(ids, null, 2)}\n`;
}

export function emptyMeta(): RemoteMeta {
  return { schemaVersion: SCHEMA_VERSION, resources: {} };
}

export const SCHEMA_VERSION = 2;

export function parseMeta(text: string | undefined): RemoteMeta {
  const value = text === undefined ? undefined : (parseJsonc(text, 'meta.json') as Partial<RemoteMeta> | undefined);
  const schemaVersion = value?.schemaVersion ?? SCHEMA_VERSION;
  if (schemaVersion > SCHEMA_VERSION) {
    throw new Error(`meta.json uses schema version ${schemaVersion}; update Zoo Sync to read it`);
  }
  return { schemaVersion: schemaVersion === 1 ? 1 : 2, resources: { ...value?.resources } };
}

export function serializeMeta(meta: RemoteMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}
