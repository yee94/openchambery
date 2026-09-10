import { describe, expect, test } from 'vitest';

import { listLynxDirectory } from './filesSurface';

describe('listLynxDirectory', () => {
  test('no-runtime / no-directory are not empty ok', async () => {
    expect(await listLynxDirectory(null, '/tmp')).toEqual({ status: 'no-runtime' });
    const runtimeFetch = async () => ({ ok: true, status: 200, json: async () => ({ entries: [] }) });
    expect(await listLynxDirectory(runtimeFetch, null)).toEqual({ status: 'no-directory' });
  });

  test('HTTP failure ≠ empty entries', async () => {
    const runtimeFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const result = await listLynxDirectory(runtimeFetch, '/repo');
    expect(result.status).toBe('failed');
  });

  test('parses Cap fs/list entries', async () => {
    const runtimeFetch = async (path: string) => {
      expect(path).toContain('/api/fs/list?');
      expect(path).toContain('path=%2Frepo');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          entries: [
            { name: 'a.ts', path: '/repo/a.ts', type: 'file' },
            { name: 'src', path: '/repo/src', isDirectory: true },
          ],
        }),
      };
    };
    const result = await listLynxDirectory(runtimeFetch, '/repo');
    expect(result).toEqual({
      status: 'ok',
      directory: '/repo',
      entries: [
        { name: 'a.ts', path: '/repo/a.ts', type: 'file' },
        { name: 'src', path: '/repo/src', type: 'directory' },
      ],
    });
  });
});

import { readLynxFile } from './filesSurface';

describe('readLynxFile', () => {
  test('no-runtime / no-path are not empty ok', async () => {
    expect(await readLynxFile(null, '/repo/a.ts')).toEqual({ status: 'no-runtime' });
    const runtimeFetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
    expect(await readLynxFile(runtimeFetch, '  ')).toEqual({ status: 'no-path' });
  });

  test('reads Cap text/plain via response.text', async () => {
    const runtimeFetch = async (path: string) => {
      expect(path).toContain('/api/fs/read?');
      expect(path).toContain('path=%2Frepo%2Fa.ts');
      return { ok: true, status: 200, json: async () => ({}), text: async () => 'hello\nworld' };
    };
    const result = await readLynxFile(runtimeFetch, '/repo/a.ts');
    expect(result).toEqual({
      status: 'ok',
      path: '/repo/a.ts',
      content: 'hello\nworld',
      truncated: false,
    });
  });

  test('HTTP failure ≠ empty preview', async () => {
    const runtimeFetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    const result = await readLynxFile(runtimeFetch, '/repo/missing.ts');
    expect(result.status).toBe('failed');
  });

  test('truncates large previews', async () => {
    const runtimeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => 'abcdefghij',
    });
    const result = await readLynxFile(runtimeFetch, '/repo/a.ts', { maxChars: 4 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.content).toBe('abcd');
    expect(result.truncated).toBe(true);
  });
});

import { searchLynxFiles } from './filesSurface';

describe('searchLynxFiles', () => {
  test('no-runtime / no-directory / no-query are not empty ok', async () => {
    expect(await searchLynxFiles(null, { directory: '/repo', query: 'a' })).toEqual({ status: 'no-runtime' });
    const runtimeFetch = async () => ({ ok: true, status: 200, json: async () => [] });
    expect(await searchLynxFiles(runtimeFetch, { directory: null, query: 'a' })).toEqual({ status: 'no-directory' });
    expect(await searchLynxFiles(runtimeFetch, { directory: '/repo', query: '  ' })).toEqual({ status: 'no-query' });
  });

  test('HTTP failure ≠ empty hits', async () => {
    const runtimeFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const result = await searchLynxFiles(runtimeFetch, { directory: '/repo', query: 'foo' });
    expect(result.status).toBe('failed');
  });

  test('parses Cap /api/find/file string[] relative paths', async () => {
    const runtimeFetch = async (path: string, init?: { headers?: Record<string, string> }) => {
      expect(path).toContain('/api/find/file?');
      expect(path).toContain('directory=%2Frepo');
      expect(path).toContain('query=util');
      expect(path).toContain('dirs=false');
      expect(path).toContain('type=file');
      expect(path).toContain('limit=40');
      expect(init?.headers?.['x-opencode-directory']).toBe('/repo');
      return {
        ok: true,
        status: 200,
        json: async () => ['src/util.ts', 'lib/util.ts'],
      };
    };
    const result = await searchLynxFiles(runtimeFetch, { directory: '/repo', query: 'util' });
    expect(result).toEqual({
      status: 'ok',
      directory: '/repo',
      query: 'util',
      hits: [
        { path: '/repo/src/util.ts', relativePath: 'src/util.ts', name: 'util.ts' },
        { path: '/repo/lib/util.ts', relativePath: 'lib/util.ts', name: 'util.ts' },
      ],
    });
  });

  test('accepts { data: string[] } OpenCode client shape', async () => {
    const runtimeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: ['a.ts'] }),
    });
    const result = await searchLynxFiles(runtimeFetch, { directory: '/repo', query: 'a', maxResults: 10 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.hits).toEqual([{ path: '/repo/a.ts', relativePath: 'a.ts', name: 'a.ts' }]);
  });

  test('empty array is ok empty (not failure)', async () => {
    const runtimeFetch = async () => ({ ok: true, status: 200, json: async () => [] });
    const result = await searchLynxFiles(runtimeFetch, { directory: '/repo', query: 'zzz' });
    expect(result).toEqual({ status: 'ok', directory: '/repo', query: 'zzz', hits: [] });
  });
});
