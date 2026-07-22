import { QueryClient } from '@tanstack/react-query';
import type { ProviderResult, QuotaProviderId } from '@/types';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity, isRuntimeEndpointIdentityChange, subscribeRuntimeEndpointChanged } from './runtime-switch';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export const queryKeys = {
  runtime: (): readonly [string] => [getRuntimeTransportIdentity()],
  scoped: <T extends ReadonlyArray<unknown>>(...parts: T): readonly [string, ...T] => [getRuntimeTransportIdentity(), ...parts],
  quota: (providerId: QuotaProviderId): readonly [string, QuotaProviderId] => [getRuntimeTransportIdentity(), providerId],
  commands: {
    list: (directory: string | null, transport = getRuntimeTransportIdentity()): readonly [string, 'commands', string | null] => [transport, 'commands', directory],
  },
  agents: {
    list: (directory: string | null, transport = getRuntimeTransportIdentity()): readonly [string, 'agents', string | null] => [transport, 'agents', directory],
    raw: (directory: string | null, transport = getRuntimeTransportIdentity()): readonly [string, 'agents', 'raw', string | null] => [transport, 'agents', 'raw', normalizeQueryDirectory(directory)],
  },
  configCatalog: {
    providers: (directory: string | null, transport = getRuntimeTransportIdentity()): readonly [string, 'configCatalog', 'providers', string | null] => [transport, 'configCatalog', 'providers', normalizeQueryDirectory(directory)],
  },
  providers: {
    list: (directory: string | null, transport = getRuntimeTransportIdentity()): readonly [string, 'providers', string | null] => [transport, 'providers', directory],
  },
  skills: {
    list: (directory: string | null, transport = getRuntimeTransportIdentity()): readonly [string, 'skills', string | null] => [transport, 'skills', directory],
  },
  skillsCatalog: {
    sources: (directory: string | null, transport = getRuntimeTransportIdentity()): readonly [string, 'skillsCatalog', 'sources', string | null] => [transport, 'skillsCatalog', 'sources', normalizeQueryDirectory(directory)],
    source: (directory: string | null, sourceId: string, transport = getRuntimeTransportIdentity()): readonly [string, 'skillsCatalog', 'source', string | null, string] => [transport, 'skillsCatalog', 'source', normalizeQueryDirectory(directory), sourceId],
  },
  messageQueue: {
    status: (transport = getRuntimeTransportIdentity()): readonly [string, 'messageQueue', 'status'] => [transport, 'messageQueue', 'status'],
    snapshot: (transport = getRuntimeTransportIdentity()): readonly [string, 'messageQueue', 'snapshot'] => [transport, 'messageQueue', 'snapshot'],
    scope: (scopeID: string, revision: number, transport = getRuntimeTransportIdentity()): readonly [string, 'messageQueue', 'scope', string, number] => [transport, 'messageQueue', 'scope', scopeID, revision],
  },
  mcp: {
    configs: (directory: string | null, transport = getRuntimeTransportIdentity()): readonly [string, 'mcp', 'configs', string | null] => [transport, 'mcp', 'configs', normalizeQueryDirectory(directory)],
    status: (directory: string | null, transport = getRuntimeTransportIdentity()): readonly [string, 'mcp', 'status', string | null] => [transport, 'mcp', 'status', normalizeQueryDirectory(directory)],
  },
  github: {
    auth: (transport = getRuntimeTransportIdentity()): readonly [string, 'github', 'auth'] => [transport, 'github', 'auth'],
  },
  git: {
    branches: (directory: string | null | undefined, transport = getRuntimeTransportIdentity()): readonly [string, 'git', 'branches', string | null] => [transport, 'git', 'branches', normalizeQueryDirectory(directory)],
    remotes: (directory: string | null | undefined, transport = getRuntimeTransportIdentity()): readonly [string, 'git', 'remotes', string | null] => [transport, 'git', 'remotes', normalizeQueryDirectory(directory)],
  },
  plugins: {
    list: (directory: string | null, transport = getRuntimeTransportIdentity()): readonly [string, 'plugins', 'list', string | null] => [transport, 'plugins', 'list', directory],
    registry: (
      directory: string | null,
      specs: readonly string[],
      force = false,
      transport = getRuntimeTransportIdentity(),
    ): readonly [string, 'plugins', 'registry', string | null, readonly string[], boolean] => [
      transport,
      'plugins',
      'registry',
      directory,
      normalizePluginRegistrySpecs(specs),
      force,
    ],
    file: (directory: string | null, id: string, transport = getRuntimeTransportIdentity()): readonly [string, 'plugins', 'file', string | null, string] => [transport, 'plugins', 'file', directory, id],
  },
  files: {
    directory: (
      scopeDirectory: string | null | undefined,
      directory: string | null | undefined,
      respectGitignore: boolean | undefined,
      transport = getRuntimeTransportIdentity(),
    ): readonly [string, 'files', 'directory', string | null, string | null, boolean] => [
      transport,
      'files',
      'directory',
      normalizeQueryPath(scopeDirectory),
      normalizeQueryPath(directory),
      Boolean(respectGitignore),
    ],
    search: (
      directory: string | null | undefined,
      query: string,
      maxResults: number | undefined,
      includeHidden: boolean | undefined,
      respectGitignore: boolean | undefined,
      transport = getRuntimeTransportIdentity(),
    ): readonly [string, 'files', 'search', string | null, string, number | null, boolean, boolean] => [
      transport,
      'files',
      'search',
      normalizeQueryPath(directory),
      query.trim(),
      maxResults ?? null,
      Boolean(includeHidden),
      Boolean(respectGitignore),
    ],
    content: (
      scopeDirectory: string | null | undefined,
      path: string | null | undefined,
      options: FileQueryReadOptions | undefined,
      transport = getRuntimeTransportIdentity(),
    ): FileQueryReadKey => fileQueryReadKey('content', scopeDirectory, path, options, transport),
    stat: (
      scopeDirectory: string | null | undefined,
      path: string | null | undefined,
      options: FileQueryReadOptions | undefined,
      transport = getRuntimeTransportIdentity(),
    ): FileQueryReadKey => fileQueryReadKey('stat', scopeDirectory, path, options, transport),
  },
  plans: {
    resolved: (
      mode: 'target' | 'session',
      sessionId: string | null | undefined,
      scopeDirectory: string | null | undefined,
      targetPath: string | null | undefined,
      repoPath: string | null | undefined,
      homePath: string | null | undefined,
      transport = getRuntimeTransportIdentity(),
    ): readonly [string, 'plans', 'resolved', 'target' | 'session', string | null, string | null, string | null, string | null, string | null] => [
      transport,
      'plans',
      'resolved',
      mode,
      sessionId?.trim() || null,
      normalizeQueryPath(scopeDirectory),
      normalizeQueryPath(targetPath),
      normalizeQueryPath(repoPath),
      normalizeQueryPath(homePath),
    ],
  },
};

export const normalizePluginRegistrySpecs = (specs: readonly string[]): string[] =>
  Array.from(new Set(specs.map((spec) => spec.trim()).filter(Boolean))).sort();

const normalizeQueryDirectory = (directory: string | null | undefined): string | null => directory?.trim() || null;

export type FileQueryReadOptions = {
  allowOutsideWorkspace?: boolean;
  outsideFileGrant?: string;
  optional?: boolean;
  directory?: string;
};

type FileQueryReadKey = readonly [
  string,
  'files',
  'content' | 'stat',
  string | null,
  string | null,
  boolean,
  string | null,
  boolean,
  string | null,
];

const normalizeQueryPath = (path: string | null | undefined): string | null => {
  if (typeof path !== 'string') return null;
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) return null;
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const fileQueryReadKey = (
  resource: 'content' | 'stat',
  scopeDirectory: string | null | undefined,
  path: string | null | undefined,
  options: FileQueryReadOptions | undefined,
  transport: string,
): FileQueryReadKey => [
  transport,
  'files',
  resource,
  normalizeQueryPath(scopeDirectory),
  normalizeQueryPath(path),
  Boolean(options?.allowOutsideWorkspace),
  options?.outsideFileGrant ?? null,
  Boolean(options?.optional),
  normalizeQueryPath(options?.directory),
];

export const fetchQuotaProvider = async (
  providerId: QuotaProviderId,
  signal: AbortSignal,
): Promise<ProviderResult> => {
  const response = await runtimeFetch(`/api/quota/${encodeURIComponent(providerId)}`, { signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || 'Failed to fetch quota');
  }
  return payload as ProviderResult;
};

export const installQueryRuntimeLifecycle = (client: Pick<QueryClient, 'clear'>): (() => void) => (
  subscribeRuntimeEndpointChanged((detail) => {
    if (isRuntimeEndpointIdentityChange(detail)) {
      client.clear();
    }
  })
);
