import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { createBrowserProviderSelectionStore } from './selection-store.js';

const dirs = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('browser provider selection store', () => {
  test('a missing file is no selection, and a write round-trips only the id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-provider-'));
    dirs.push(dir);
    const store = createBrowserProviderSelectionStore(path.join(dir, 'nested', 'browser-provider-selection.json'));
    await expect(store.read()).resolves.toBeNull();
    await store.write('server-chrome');
    await expect(store.read()).resolves.toBe('server-chrome');
    const raw = await fs.readFile(path.join(dir, 'nested', 'browser-provider-selection.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({ selectedId: 'server-chrome' });
  });

  test('a corrupt file is a read failure, not an empty selection', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-provider-'));
    dirs.push(dir);
    const filePath = path.join(dir, 'browser-provider-selection.json');
    await fs.writeFile(filePath, '{', 'utf8');
    const store = createBrowserProviderSelectionStore(filePath);
    await expect(store.read()).rejects.toThrow();
  });
});