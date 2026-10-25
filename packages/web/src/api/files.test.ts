import { describe, expect, it, vi } from 'vitest';

import type { RuntimeUrlQuery, RuntimeUrlResolver } from '@yuri/ui/lib/runtime-url';

const runtimeFetchMock = vi.fn();
const downloadMock = vi.fn();
const readMock = vi.fn();
vi.mock('@yuri/ui/lib/runtime-file-resource', () => ({ readRuntimeFile: readMock }));
vi.mock('@yuri/ui/lib/runtime-file-download', () => ({ downloadRuntimeFile: downloadMock }));

vi.mock('@yuri/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

const toUrl = (path: string, query?: RuntimeUrlQuery): string => {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams();
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
};

const urls: RuntimeUrlResolver = {
  api: toUrl,
  authenticatedAsset: toUrl,
  auth: toUrl,
  health: (query?: RuntimeUrlQuery) => toUrl('/health', query),
  rawFile: (path: string) => toUrl('/api/fs/raw', new URLSearchParams({ path })),
  sse: toUrl,
  websocket: toUrl,
};

describe('createWebFilesAPI', () => {
  it('uses per-call workspace directory for stat and read requests', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/stale-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/worktree-b/file.txt', isFile: true, size: 12 }));
    await api.statFile?.('/worktree-b/file.txt', { directory: '/worktree-a' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/stat', {
      query: new URLSearchParams({ path: '/worktree-b/file.txt' }),
      headers: { 'x-opencode-directory': '/worktree-a' },
    });

    readMock.mockResolvedValueOnce(new Response('content'));
    await api.readFile?.('/worktree-b/file.txt', { directory: '/worktree-a' });

    expect(readMock).toHaveBeenLastCalledWith({ path: '/worktree-b/file.txt', directory: '/worktree-a' });
  });

  it('sends the workspace directory header for downloads', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    downloadMock.mockRejectedValueOnce(new Error('Download failed'));
    await expect(api.downloadFile?.('/current-workspace/file.txt')).rejects.toThrow('Download failed');

    expect(downloadMock).toHaveBeenLastCalledWith({ path: '/current-workspace/file.txt', directory: '/current-workspace' });
  });

  it('parses optional read existence headers and disables caching', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(new Response('', {
      headers: { 'x-yuri-file-exists': 'false' },
    }));
    await expect(api.readFile?.('/current-workspace/missing.txt', { optional: true, directory: '/worktree-a' }))
      .resolves.toEqual({ content: '', path: '/current-workspace/missing.txt', exists: false });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/read', {
      query: new URLSearchParams({ path: '/current-workspace/missing.txt', optional: 'true' }),
      cache: 'no-store',
      headers: { 'x-opencode-directory': '/worktree-a' },
    });

    runtimeFetchMock.mockResolvedValueOnce(new Response('', {
      headers: { 'x-yuri-file-exists': 'true' },
    }));
    await expect(api.readFile?.('/current-workspace/empty.txt', { optional: true }))
      .resolves.toEqual({ content: '', path: '/current-workspace/empty.txt', exists: true });
  });

  it('fails optional reads when the server omits the authoritative existence header', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(new Response(''));

    await expect(api.readFile?.('/current-workspace/file.txt', { optional: true }))
      .rejects.toThrow('Optional file read requires an existence response header');
  });
});
