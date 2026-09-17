import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSettingClassifier, detectAppId } from '../../src/sync/apps';

const manifest = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
const defaultAppSettings: Record<string, string[]> =
  manifest.contributes.configuration.properties['zooSync.appSettings'].default;

describe('detectAppId', () => {
  it.each([
    ['vscode', 'code'],
    ['vscode-insiders', 'code'],
    ['cursor', 'cursor'],
    ['vscodium', 'vscodium'],
    ['', 'code'],
  ])('maps the %s uri scheme to %s', (scheme, expected) => {
    expect(detectAppId(scheme)).toBe(expected);
  });

  it('prefers a configured id and normalizes it', () => {
    expect(detectAppId('cursor', ' Work Laptop ')).toBe('worklaptop');
    expect(detectAppId('cursor', '   ')).toBe('cursor');
  });
});

describe('createSettingClassifier', () => {
  const classify = (appId: string) => createSettingClassifier({ cursor: ['cursor.*'], code: ['chat.*'] }, appId);

  it('keeps this app keys, shares the rest and leaves other apps alone', () => {
    const inCursor = classify('cursor');
    expect(inCursor('cursor.cpp.disabledLanguages')).toBe('mine');
    expect(inCursor('chat.agent.enabled')).toBe('foreign');
    expect(inCursor('editor.fontSize')).toBe('shared');

    const inCode = classify('code');
    expect(inCode('chat.agent.enabled')).toBe('mine');
    expect(inCode('cursor.cpp.disabledLanguages')).toBe('foreign');
  });

  it('shares everything when nothing is configured', () => {
    const classifier = createSettingClassifier({}, 'cursor');
    expect(classifier('cursor.x')).toBe('shared');
  });

  it('applies the shipped defaults to Cursor keys', () => {
    const inCode = createSettingClassifier(defaultAppSettings, 'code');
    expect(inCode('cursor.general.betaFeatures')).toBe('foreign');
    expect(inCode('editor.fontSize')).toBe('shared');
  });
});
