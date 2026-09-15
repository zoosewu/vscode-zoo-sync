import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

export class JsoncSyntaxError extends Error {
  constructor(
    readonly source: string,
    readonly errors: ParseError[],
  ) {
    const details = errors.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`).join(', ');
    super(`${source} has syntax errors: ${details}`);
    this.name = 'JsoncSyntaxError';
  }
}

/** Parses JSON with comments. Returns `undefined` for blank text and throws on syntax errors. */
export function parseJsonc(text: string, source: string): unknown {
  if (text.trim() === '') {
    return undefined;
  }
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new JsoncSyntaxError(source, errors);
  }
  return value;
}

/** JSON with object keys sorted recursively, so comments, formatting and key order never count as changes. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function jsonEquals(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

/** Own-property lookup, so keys such as `constructor` never resolve to prototype members. */
export function own<T>(obj: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}
