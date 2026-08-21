import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSettingsStore } from './settings-store.mjs';

const tempDirs = [];

const makeTempDir = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-settings-store-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fsp.rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('createSettingsStore', () => {
  test('serializes concurrent mutate calls so sibling fields are not lost', async () => {
    const tempDir = await makeTempDir();
    const settingsFilePath = path.join(tempDir, 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ seed: true }, null, 2));
    const store = createSettingsStore({ filePath: settingsFilePath });

    const writers = Array.from({ length: 20 }, (_, index) => store.mutate(async (root) => {
      // Yield so RMW pairs would interleave without the mutation chain.
      await new Promise((resolve) => setTimeout(resolve, index % 3));
      root[`field_${index}`] = index;
      return root;
    }));

    await Promise.all(writers);

    const finalRoot = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    expect(finalRoot.seed).toBe(true);
    for (let index = 0; index < 20; index += 1) {
      expect(finalRoot[`field_${index}`]).toBe(index);
    }
  });

  test('keeps the chain alive after a mutator throws', async () => {
    const tempDir = await makeTempDir();
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const store = createSettingsStore({ filePath: settingsFilePath });

    await expect(store.mutate(() => {
      throw new Error('boom');
    })).rejects.toThrow(/boom/);

    await store.mutate((root) => {
      root.ok = true;
      return root;
    });

    expect(JSON.parse(fs.readFileSync(settingsFilePath, 'utf8')).ok).toBe(true);
  });

  test('runExclusive shares the same serialization chain as mutate', async () => {
    const tempDir = await makeTempDir();
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const store = createSettingsStore({ filePath: settingsFilePath });
    const order = [];

    const first = store.mutate(async (root) => {
      order.push('mutate-start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      root.fromMutate = 1;
      order.push('mutate-end');
      return root;
    });
    const second = store.runExclusive(async () => {
      order.push('exclusive');
      const root = store.readRoot();
      expect(root.fromMutate).toBe(1);
      return 'done';
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['mutate-start', 'mutate-end', 'exclusive']);
  });
});
