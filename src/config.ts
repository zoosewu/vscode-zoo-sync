import * as vscode from 'vscode';
import type { FileSpec } from './sync/pathSpec';

const SECTION = 'zooSync';

export interface ZooSyncConfig {
  repository: string;
  profiles: string[];
  files: FileSpec[];
  branch: string;
  autoSync: boolean;
  remotePollMinutes: number;
  localSyncMinutes: number;
  ignoredSettings: string[];
  ignoredExtensions: string[];
}

export function readConfig(): ZooSyncConfig {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    repository: config.get<string>('repository', '').trim(),
    profiles: config.get<string[]>('profiles', ['Default']),
    files: config.get<FileSpec[]>('files', []),
    branch: config.get<string>('branch', 'main').trim() || 'main',
    autoSync: config.get<boolean>('autoSync', true),
    remotePollMinutes: Math.max(5, config.get<number>('remotePollMinutes', 30)),
    localSyncMinutes: Math.max(1, config.get<number>('localSyncMinutes', 5)),
    ignoredSettings: config.get<string[]>('ignoredSettings', []),
    ignoredExtensions: config.get<string[]>('ignoredExtensions', []),
  };
}

export function affectsConfig(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SECTION);
}

export async function updateConfig(key: keyof ZooSyncConfig, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}
