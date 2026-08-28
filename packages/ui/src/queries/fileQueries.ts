import { useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import React from 'react';
import type { DirectoryListResult, FilesAPI } from '@/lib/api/types';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { queryClient, queryKeys, type FileQueryReadOptions } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';

type FileReadOptions = NonNullable<Parameters<NonNullable<FilesAPI['readFile']>>[1]>;
type FileStatResult = Awaited<ReturnType<NonNullable<FilesAPI['statFile']>>>;

type FileDirectoryQueryInput = {
  scopeDirectory: string | null;
  directory: string | null;
  respectGitignore?: boolean;
};

type FileSearchQueryInput = {
  directory: string | null;
  query: string;
  maxResults?: number;
  includeHidden?: boolean;
  respectGitignore?: boolean;
};

type FileContentQueryInput = {
  scopeDirectory: string | null;
  path: string | null;
  options?: FileReadOptions;
};

type FileStatQueryInput = FileContentQueryInput;

const readOptionsKey = (options: FileReadOptions | undefined): FileQueryReadOptions | undefined => options;

export const fileContentQueryKey = (
  input: FileContentQueryInput,
  transport = getRuntimeTransportIdentity(),
) => queryKeys.files.content(input.scopeDirectory, input.path, readOptionsKey(input.options), transport);

export const fileDirectoryQueryOptions = (
  files: FilesAPI,
  input: FileDirectoryQueryInput,
  transport = getRuntimeTransportIdentity(),
) => ({
  queryKey: queryKeys.files.directory(input.scopeDirectory, input.directory, input.respectGitignore, transport),
  queryFn: async (): Promise<DirectoryListResult> => {
    if (!input.directory) throw new Error('A directory is required to list files');
    return input.respectGitignore === undefined
      ? files.listDirectory(input.directory)
      : files.listDirectory(input.directory, { respectGitignore: input.respectGitignore });
  },
});

export const fileSearchQueryOptions = (
  files: FilesAPI,
  input: FileSearchQueryInput,
  transport = getRuntimeTransportIdentity(),
) => ({
  queryKey: queryKeys.files.search(
    input.directory,
    input.query,
    input.maxResults,
    input.includeHidden,
    input.respectGitignore,
    transport,
  ),
  queryFn: async () => {
    if (!input.directory) throw new Error('A directory is required to search files');
    const request = {
      directory: input.directory,
      query: input.query.trim(),
      maxResults: input.maxResults,
      ...(input.includeHidden === undefined ? {} : { includeHidden: input.includeHidden }),
      ...(input.respectGitignore === undefined ? {} : { respectGitignore: input.respectGitignore }),
    };
    return files.search(request);
  },
});

export const fileContentQueryOptions = (
  files: FilesAPI,
  input: FileContentQueryInput,
  transport = getRuntimeTransportIdentity(),
) => ({
  queryKey: fileContentQueryKey(input, transport),
  queryFn: async (): Promise<string> => {
    if (!input.path) throw new Error('A file path is required to read file content');
    if (!files.readFile) throw new Error('File content reads are unavailable in this runtime');
    return (await (input.options === undefined ? files.readFile(input.path) : files.readFile(input.path, input.options))).content;
  },
});

export const setFileContentSnapshot = (
  client: Pick<QueryClient, 'setQueryData'>,
  input: FileContentQueryInput,
  transport: string,
  content: string,
): void => {
  client.setQueryData(
    fileContentQueryKey(input, transport),
    content,
  );
};

export const fileStatQueryOptions = (
  files: FilesAPI,
  input: FileStatQueryInput,
  transport = getRuntimeTransportIdentity(),
) => ({
  queryKey: queryKeys.files.stat(input.scopeDirectory, input.path, readOptionsKey(input.options), transport),
  queryFn: async (): Promise<FileStatResult> => {
    if (!input.path) throw new Error('A file path is required to read file status');
    if (!files.statFile) throw new Error('File status reads are unavailable in this runtime');
    return input.options === undefined ? files.statFile(input.path) : files.statFile(input.path, input.options);
  },
});

export const useFileDirectoryQuery = (
  input: FileDirectoryQueryInput,
  options: { enabled?: boolean; refetchOnMount?: 'always' | boolean } = {},
) => {
  const { files } = useRuntimeAPIs();
  const transport = getRuntimeTransportIdentity();
  return useQuery({ ...fileDirectoryQueryOptions(files, input, transport), ...options });
};

export const useFileSearchQuery = (
  input: FileSearchQueryInput,
  options: { enabled?: boolean } = {},
) => {
  const { files } = useRuntimeAPIs();
  const transport = getRuntimeTransportIdentity();
  return useQuery({ ...fileSearchQueryOptions(files, input, transport), ...options });
};

export const useFileContentQuery = (
  input: FileContentQueryInput,
  options: { enabled?: boolean } = {},
) => {
  const { files } = useRuntimeAPIs();
  const transport = getRuntimeTransportIdentity();
  return useQuery({ ...fileContentQueryOptions(files, input, transport), ...options });
};

const FILE_STAT_WATCH_INTERVAL_MS = 2_000;

/**
 * Watch an open file for external changes while a read-only preview is active.
 * Polls stat (cheap) and invalidates the content query only when size or
 * mtime actually moved, mirroring the desktop FilesView poll behavior.
 * No-op when the runtime lacks statFile.
 */
export const useFileStatWatcher = (
  input: FileContentQueryInput,
  options: { enabled?: boolean; intervalMs?: number; client?: Pick<QueryClient, 'invalidateQueries'> } = {},
) => {
  const { files } = useRuntimeAPIs();
  const transport = getRuntimeTransportIdentity();
  const enabled = Boolean(options.enabled && input.path && files.statFile);

  const statQuery = useQuery({
    ...fileStatQueryOptions(files, input, transport),
    enabled,
    refetchInterval: options.intervalMs ?? FILE_STAT_WATCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  const watchedPathRef = React.useRef<string | null>(null);
  const previousSignatureRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const stat = statQuery.data;
    if (!enabled || !stat) {
      return;
    }
    // A path switch starts a fresh watch baseline — never compare stats across files.
    if (watchedPathRef.current !== input.path) {
      watchedPathRef.current = input.path ?? null;
      previousSignatureRef.current = null;
    }
    const signature = `${stat.size}:${stat.mtimeMs ?? ''}`;
    const previous = previousSignatureRef.current;
    previousSignatureRef.current = signature;
    if (previous === null || previous === signature) {
      return;
    }
    const client = options.client ?? queryClient;
    void client.invalidateQueries({ queryKey: fileContentQueryKey(input, transport) });
  });
};
