import { describe, expect, it } from 'vitest';
import { canonicalize, jsonEquals, JsoncSyntaxError, own, parseJsonc } from '../../src/sync/canonical';

describe('canonicalize', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalize({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });

  it('treats key order and formatting as equal', () => {
    const a = parseJsonc('{ "x": 1, "y": [1, 2] }', 'a');
    const b = parseJsonc('// comment\n{\n\t"y": [1, 2],\n\t"x": 1,\n}', 'b');
    expect(jsonEquals(a, b)).toBe(true);
  });

  it('distinguishes absent from null', () => {
    expect(jsonEquals(undefined, null)).toBe(false);
    expect(jsonEquals(undefined, undefined)).toBe(true);
  });
});

describe('parseJsonc', () => {
  it('returns undefined for blank text', () => {
    expect(parseJsonc('  \n', 'blank')).toBeUndefined();
  });

  it('throws JsoncSyntaxError with the source name', () => {
    expect(() => parseJsonc('{ "a": }', 'settings.json')).toThrow(JsoncSyntaxError);
    expect(() => parseJsonc('{ "a": }', 'settings.json')).toThrow(/settings\.json/);
  });
});

describe('own', () => {
  it('ignores prototype members', () => {
    expect(own({}, 'constructor')).toBeUndefined();
    expect(own({ constructor: 1 }, 'constructor')).toBe(1);
  });
});
