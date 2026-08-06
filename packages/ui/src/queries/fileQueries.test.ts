import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { QueryClient } from '@tanstack/react-query';
import type { FilesAPI } from '@/lib/api/types';

let runtimeKey = 'runtime-a';

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => runtimeKey,
  getRuntimeGeneration: () => 0,
  isRuntimeEndpointIdentityChange: () => false,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

const {
  fileContentQueryOptions,
  fileDirectoryQueryOptions,
  fileSearchQueryOptions,
  fileStatQueryOptions,
  setFileContentSnapshot,
} = await import('./fileQueries');
const { queryClient, queryKeys } = await import('@/lib/queryRuntime');

const createFilesAPI = (overrides: Partial<FilesAPI> = {}): FilesAPI => ({
  listDirectory: async (directory) => ({ directory, entries: [] }),
  search: async () => [],
  createDirectory: async (path) => ({ success: true, path }),
  ...overrides,
});

describe('fileQueries', () => {
  beforeEach(() => {
    queryClient.clear();
    runtimeKey = 'runtime-a';
  });

  test('keys isolate transport, scope, resources, options, and normalized paths', () => {
    expect(queryKeys.files.directory(' C:\\project\\ ', ' C:\\project\\src\\ ', undefined, 'runtime-a'))
      .toEqual(['runtime-a', 'files', 'directory', 'C:/project', 'C:/project/src', false]);
    expect(queryKeys.files.directory('/project', '/project/src', true, 'runtime-b'))
      .toEqual(['runtime-b', 'files', 'directory', '/project', '/project/src', true]);
    expect(queryKeys.files.search(' /project/ ', ' needle ', 40, true, false, 'runtime-a'))
      .toEqual(['runtime-a', 'files', 'search', '/project', 'needle', 40, true, false]);
    expect(queryKeys.files.content('/project/', '/project/file.txt/', {
      allowOutsideWorkspace: true,
      outsideFileGrant: 'grant-a',
      optional: true,
      directory: ' /project/sub/ ',
    }, 'runtime-a'))
      .toEqual(['runtime-a', 'files', 'content', '/project', '/project/file.txt', true, 'grant-a', true, '/project/sub']);
    expect(queryKeys.files.content('/project', '/project/file.txt', {}, 'runtime-a'))
      .not.toEqual(queryKeys.files.stat('/project', '/project/file.txt', {}, 'runtime-a'));
  });

  test('factories retain the supplied FilesAPI and request inputs', async () => {
    const firstCalls: string[] = [];
    const first = createFilesAPI({
      listDirectory: async (directory) => {
        firstCalls.push(directory);
        return { directory, entries: [] };
      },
    });
    const second = createFilesAPI({
      listDirectory: async () => {
        throw new Error('new runtime API was used');
      },
    });
    const options = fileDirectoryQueryOptions(first, {
      scopeDirectory: '/project',
      directory: '/project/src',
    }, 'runtime-a');

    await options.queryFn();
    await expect(fileDirectoryQueryOptions(second, {
      scopeDirectory: '/project',
      directory: '/project/src',
    }, 'runtime-b').queryFn()).rejects.toThrow('new runtime API was used');

    expect(firstCalls).toEqual(['/project/src']);
  });

  test('matching fetches share one query flight and failures retain the prior snapshot', async () => {
    let calls = 0;
    let resolveList: ((value: { directory: string; entries: [] }) => void) | undefined;
    const files = createFilesAPI({
      listDirectory: async () => {
        calls += 1;
        return new Promise((resolve) => { resolveList = resolve; });
      },
    });
    const input = { scopeDirectory: '/project', directory: '/project/src' };
    const first = queryClient.fetchQuery(fileDirectoryQueryOptions(files, input, runtimeKey));
    const second = queryClient.fetchQuery(fileDirectoryQueryOptions(files, input, runtimeKey));
    resolveList?.({ directory: '/project/src', entries: [] });
    await Promise.all([first, second]);

    queryClient.setQueryData(queryKeys.files.directory('/project', '/project/src', undefined, runtimeKey), {
      directory: '/project/src',
      entries: [{ name: 'saved.ts', path: '/project/src/saved.ts', isDirectory: false }],
    });
    const failingFiles = createFilesAPI({ listDirectory: async () => { throw new Error('offline'); } });

    await expect(queryClient.fetchQuery({ ...fileDirectoryQueryOptions(failingFiles, input, runtimeKey), staleTime: 0 }))
      .rejects.toThrow('offline');
    expect(queryClient.getQueryData<{ entries: Array<{ name: string }> }>(queryKeys.files.directory('/project', '/project/src', undefined, runtimeKey))?.entries[0]?.name)
      .toBe('saved.ts');
    expect(calls).toBe(1);
  });

  test('content and stat capability gaps fail explicitly', async () => {
    const files = createFilesAPI();

    await expect(fileContentQueryOptions(files, { scopeDirectory: '/project', path: '/project/file.txt' }).queryFn())
      .rejects.toThrow('File content reads are unavailable in this runtime');
    await expect(fileStatQueryOptions(files, { scopeDirectory: '/project', path: '/project/file.txt' }).queryFn())
      .rejects.toThrow('File status reads are unavailable in this runtime');
    await expect(fileSearchQueryOptions(files, { directory: null, query: 'file' }).queryFn())
      .rejects.toThrow('A directory is required to search files');
  });

  test('writes content snapshots to the exact transport, scope, path, and options key', () => {
    const calls: unknown[][] = [];
    const client = {
      setQueryData: (...args: unknown[]) => {
        calls.push(args);
        return undefined;
      },
    } as Pick<QueryClient, 'setQueryData'>;
    const input = {
      scopeDirectory: '/project',
      path: '/project/diagram.drawio',
      options: { optional: true },
    };

    setFileContentSnapshot(client, input, 'runtime-b', '<saved />');

    expect(calls).toEqual([[
      queryKeys.files.content('/project', '/project/diagram.drawio', { optional: true }, 'runtime-b'),
      '<saved />',
    ]]);
  });
});