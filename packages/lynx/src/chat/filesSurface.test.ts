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
