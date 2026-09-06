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
