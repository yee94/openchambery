import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const hostRoot = join(dirname(fileURLToPath(import.meta.url)), '../../host');

describe('native host sources', () => {
  test('iOS host mirrors Mode B tab chrome and never adds a Chat tab', async () => {
    const host = await readFile(join(hostRoot, 'ios/OpenChamberLynxHostController.swift'), 'utf8');
    const embedding = await readFile(join(hostRoot, 'ios/OpenChamberLynxEmbedding.swift'), 'utf8');
    expect(embedding).toContain('liquidGlassTabBarMajor = 26');
    expect(host).toContain('projects');
    expect(host).toContain('assistant');
    expect(host).toContain('scheduled');
    expect(host).toContain('settings');
    expect(host).toContain('Chat is never a tab item');
    expect(host).not.toMatch(/tabIds = \[[^\]]*chat/);
  });

  test('Android host is Mode A with blur downgrade and no Material twin dock', async () => {
    const activity = await readFile(join(hostRoot, 'android/OpenChamberLynxHostActivity.kt'), 'utf8');
    const embedding = await readFile(join(hostRoot, 'android/OpenChamberLynxEmbedding.kt'), 'utf8');
    expect(embedding).toContain('androidGlassDowngrade = true');
    expect(activity).toContain('Do not add a fifth Chat destination');
    expect(activity).toContain('com.yee94.openchamber');
  });
});
