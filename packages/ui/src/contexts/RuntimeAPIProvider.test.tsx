import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RuntimeAPIProvider } from './RuntimeAPIProvider';
import { RuntimeAPIContext } from './runtimeAPIContext';
import type { FilesAPI, RuntimeAPIs } from '@/lib/api/types';
import { validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { removeContentBytes } from '@/sync/content-cache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const path = '/workspace/cache-reopen.txt';
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  removeContentBytes(path);
  container.remove();
});

async function mountFiles(overrides: Partial<FilesAPI>): Promise<FilesAPI> {
  const files: FilesAPI = {
    listDirectory: vi.fn(),
    search: vi.fn(),
    createDirectory: vi.fn(),
    ...overrides,
  };
  const apis = { files } as RuntimeAPIs;
  let cachedFiles: FilesAPI | undefined;
  await act(async () => root.render(
    <RuntimeAPIProvider apis={apis}>
      <RuntimeAPIContext.Consumer>
        {(value) => { cachedFiles = value?.files; return null; }}
      </RuntimeAPIContext.Consumer>
    </RuntimeAPIProvider>,
  ));
  if (!cachedFiles) throw new Error('Runtime files were not provided');
  return cachedFiles;
}

const stableStat = () => ({ path, isFile: true, size: 0, mtimeMs: 1 });

describe('RuntimeAPIProvider optional file reads', () => {
  test('reopens an unchanged empty file through the real open guard using cached content', async () => {
    const readFile = vi.fn(async () => ({ path, content: '', exists: true }));
    const files = await mountFiles({ readFile, statFile: vi.fn(async () => stableStat()) });

    expect(await validateContextFileOpen(files, path)).toEqual({ ok: true });
    expect(await validateContextFileOpen(files, path)).toEqual({ ok: true });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  test('refreshes an optional read after a regular read without existence metadata', async () => {
    const readFile = vi.fn<NonNullable<FilesAPI['readFile']>>(async (_path, options) =>
      options?.optional ? { path, content: '', exists: true } : { path, content: '' });
    const files = await mountFiles({ readFile, statFile: vi.fn(async () => stableStat()) });

    await files.readFile!(path);
    expect(await validateContextFileOpen(files, path)).toEqual({ ok: true });
    expect(await validateContextFileOpen(files, path)).toEqual({ ok: true });
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  test('reports a cached file as missing after deletion', async () => {
    let exists = true;
    const files = await mountFiles({
      readFile: async () => ({ path, content: '', exists }),
      statFile: async () => {
        if (!exists) throw new Error('File not found');
        return stableStat();
      },
    });

    expect(await validateContextFileOpen(files, path)).toEqual({ ok: true });
    exists = false;
    expect(await validateContextFileOpen(files, path)).toEqual({ ok: false, reason: 'missing' });
    expect(await validateContextFileOpen(files, path)).toEqual({ ok: false, reason: 'missing' });
  });

  test('rechecks existence without stat support, including missing files later created', async () => {
    let exists = false;
    const readFile = vi.fn(async () => ({ path, content: '', exists }));
    const files = await mountFiles({ readFile });

    expect(await validateContextFileOpen(files, path)).toEqual({ ok: false, reason: 'missing' });
    expect(await validateContextFileOpen(files, path)).toEqual({ ok: false, reason: 'missing' });
    exists = true;
    expect(await validateContextFileOpen(files, path)).toEqual({ ok: true });
    exists = false;
    expect(await validateContextFileOpen(files, path)).toEqual({ ok: false, reason: 'missing' });
    expect(readFile).toHaveBeenCalledTimes(4);
  });

  test('does not manufacture existence metadata when the runtime omits it', async () => {
    const files = await mountFiles({
      readFile: async () => ({ path, content: '' }),
      statFile: async () => stableStat(),
    });
    expect(await validateContextFileOpen(files, path)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await validateContextFileOpen(files, path)).toEqual({ ok: false, reason: 'unreadable' });
  });
});
