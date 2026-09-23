import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { normalizePath as normalize } from '@/lib/pathNormalization';

type Domain = 'providers' | 'agents' | 'commands' | 'skills' | 'mcp' | 'plugins';
const domainsByEvent: Record<string, readonly Domain[]> = {
  'credential.updated': ['providers'],
  'credential.switched': ['providers'],
  'integration.updated': ['providers'],
  'provider.updated': ['providers'],
  'model.updated': ['providers'],
  'config.updated': ['providers', 'agents', 'plugins'],
  'agent.updated': ['agents'],
  'command.updated': ['commands'],
  'skill.updated': ['skills'],
  'mcp.status.changed': ['mcp'],
  'mcp.resources.changed': ['mcp'],
  'plugin.updated': ['plugins'],
};
const allDomains: readonly Domain[] = ['providers', 'agents', 'commands', 'skills', 'mcp', 'plugins'];

function catalogScope(key: QueryKey): { domain: Domain; directory: string | null } | undefined {
  if (key[2] === 'provider-connections') return { domain: 'providers', directory: normalize(key[3] as string | null) };
  if (key[1] === 'configCatalog' && key[2] === 'providers') return { domain: 'providers', directory: normalize(key[3] as string | null) };
  if (key[1] === 'providers') return { domain: 'providers', directory: normalize(key[2] as string | null) };
  if (key[1] === 'agents') return { domain: 'agents', directory: key[2] === 'raw' ? null : normalize(key[2] as string | null) };
  if (key[1] === 'commands' || key[1] === 'skills') return { domain: key[1], directory: normalize(key[2] as string | null) };
  if (key[1] === 'mcp' || key[1] === 'plugins') return { domain: key[1], directory: normalize(key[3] as string | null) };
  if (key[1] === 'skillsCatalog') return { domain: 'skills', directory: normalize(key[3] as string | null) };
  return undefined;
}

/** One bounded batch per burst, plus a trailing batch for events during a pull.
 * Inactive queries only become stale. Never enumerate projects or touch sessions.
 */
export function createConfigLiveRefresh(deps: {
  client: Pick<QueryClient, 'invalidateQueries'>;
  identity: () => { transport: string; generation: number };
  refreshProjections: (directory: string | undefined, domains: ReadonlySet<Domain>) => Promise<unknown>;
  onError: (error: unknown) => void;
}) {
  let pending = new Map<string | undefined, Set<Domain>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let captured = deps.identity();
  let running = false;
  const current = (identity: typeof captured) => {
    const now = deps.identity();
    return now.transport === identity.transport && now.generation === identity.generation;
  };
  const schedule = () => {
    if (timer || running) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, 100);
  };
  const flush = async () => {
    if (!current(captured)) { pending.clear(); return; }
    const batch = pending;
    const identity = captured;
    pending = new Map();
    const globalDomains = batch.get(undefined);
    if (globalDomains) {
      for (const [directory, domains] of batch) {
        if (directory === undefined) continue;
        for (const domain of globalDomains) domains.delete(domain);
        if (!domains.size) batch.delete(directory);
      }
    }
    running = true;
    try {
      await deps.client.invalidateQueries({
        predicate: (query) => {
          if (query.queryKey[0] !== identity.transport) return false;
          const scope = catalogScope(query.queryKey);
          if (!scope) return false;
          return [...batch].some(([directory, domains]) => domains.has(scope.domain)
            && (directory === undefined || scope.directory === null || scope.directory === directory));
        },
        refetchType: 'active',
      });
      if (!current(identity)) return;
      await Promise.all([...batch].map(([directory, domains]) => deps.refreshProjections(directory, domains)));
    } catch (error) {
      if (current(identity)) deps.onError(error);
    } finally {
      running = false;
      if (pending.size) schedule();
    }
  };
  return {
    event(type: string, directory?: string): boolean {
      const domains = type === 'server.connected' ? allDomains : Object.hasOwn(domainsByEvent, type) ? domainsByEvent[type] : undefined;
      if (!domains) return false;
      if (!current(captured)) { pending.clear(); captured = deps.identity(); }
      const scope = type.startsWith('credential.') || !directory || directory === 'global'
        ? undefined : normalize(directory) ?? undefined;
      const bucket = pending.get(scope) ?? new Set<Domain>();
      for (const domain of domains) bucket.add(domain);
      pending.set(scope, bucket);
      schedule();
      return true;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}
