import { describe, expect, test } from 'vitest';

import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  addLynxProjectFromPath,
  appendLynxBrowsePathSegment,
  buildLynxBrowseRows,
  collectLynxAddedProjectPaths,
  ensureLynxBrowseDirectoryPath,
  getLynxBrowseParentPath,
  loadLynxFsHome,
} from './directoryExplorer';

const jsonFetch = (handlers: Record<string, (init?: RequestInit) => { status: number; body: unknown }>): LynxRuntimeFetch => (
  async (path, init) => {
    const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`;
    const handler = handlers[key] ?? handlers[path.split('?')[0]];
    if (!handler) {
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      } as never;
    }
    const result = handler(init);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
      text: async () => JSON.stringify(result.body),
    } as never;
  }
);

describe('directoryExplorer path helpers', () => {
  test('parent / append / ensure trailing slash', () => {
    expect(ensureLynxBrowseDirectoryPath('/Users/yee')).toBe('/Users/yee/');
    expect(getLynxBrowseParentPath('/Users/yee/src/')).toBe('/Users/yee/');
    expect(getLynxBrowseParentPath('/')).toBeNull();
    expect(appendLynxBrowsePathSegment('/Users/', 'yee')).toBe('/Users/yee/');
  });

  test('build browse rows marks already-added directories', () => {
    const rows = buildLynxBrowseRows(
      [
        { name: 'alpha', path: '/work/alpha', type: 'directory' },
        { name: 'file.ts', path: '/work/file.ts', type: 'file' },
      ],
      '/work/',
      new Set(['/work/alpha']),
    );
    expect(rows[0]).toEqual({ type: 'up', path: '/', disabled: false });
    expect(rows[1]).toMatchObject({ type: 'directory', name: 'alpha', alreadyAdded: true });
    expect(rows.some((row) => row.type === 'directory' && row.name === 'file.ts')).toBe(false);
  });
});

describe('directoryExplorer APIs', () => {
  test('loadLynxFsHome hits Cap route', async () => {
    const result = await loadLynxFsHome(jsonFetch({
      'GET /api/fs/home': () => ({ status: 200, body: { home: '/Users/yee' } }),
    }));
    expect(result).toEqual({ status: 'ok', home: '/Users/yee' });
  });

  test('addLynxProjectFromPath patches settings projects', async () => {
    let saved: unknown = null;
    const runtimeFetch = jsonFetch({
      'GET /api/config/settings': () => ({ status: 200, body: { projects: [] } }),
      'PUT /api/config/settings': (init) => {
        saved = JSON.parse(String(init?.body ?? '{}'));
        return { status: 200, body: { ok: true } };
      },
    });
    const result = await addLynxProjectFromPath(runtimeFetch, '/workspace/openchambery');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.created).toBe(true);
    expect(saved).toMatchObject({
      projects: [expect.objectContaining({ path: '/workspace/openchambery' })],
    });
  });

  test('collect added paths', () => {
    expect([...collectLynxAddedProjectPaths([{ path: '/a/' }, { path: '/b' }])].sort()).toEqual(['/a', '/b']);
  });

  test('no-runtime does not fake success', async () => {
    expect(await loadLynxFsHome(null)).toEqual({ status: 'no-runtime' });
    expect(await addLynxProjectFromPath(null, '/x')).toEqual({ status: 'no-runtime' });
  });
});
