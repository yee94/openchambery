import { beforeEach, describe, expect, test } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { SessionIndexSnapshot } from '@/lib/session-index-api';
import {
  ensureSessionIndexRevisionQuery,
  ensureSessionIndexSnapshotQuery,
  readSessionIndexSnapshotQuery,
  refreshSessionIndexSnapshotQuery,
  seedSessionIndexSnapshotQuery,
  sessionIndexSnapshotQueryOptions,
  writeSessionIndexSnapshotQuery,
} from './sessionIndexQueries';
import {
  readSessionIndexStartupSnapshot,
  writeSessionIndexStartupSnapshot,
  type SessionIndexStartupStorage,
} from './sessionIndexStartupCache';

const memoryStorage = (value: string | null = null): SessionIndexStartupStorage & { value: () => string | null } => {
  let current = value;
  return {
    getItem: () => current,
    setItem: (_key, next) => { current = next; },
    value: () => current,
  };
};

const snapshot = (revision = 1, directory = '/repo'): SessionIndexSnapshot => ({
  revision,
  sync: {
    active: false,
    completed: 1,
    total: 1,
    pendingDirectories: [],
    completedDirectories: [directory],
    failedDirectories: [],
  },
  directories: [{
    directory,
    cursor: null,
    hasMore: false,
    lastSyncedAt: 1,
    lastFullSyncedAt: 1,
    lastAccessedAt: 1,
    sessions: [],
  }],
});

describe('sessionIndexQueries', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  test('keys queries by transport and isolates memory entries', () => {
    expect(sessionIndexSnapshotQueryOptions('transport-a', 'runtime-a').queryKey)
      .toEqual(['transport-a', 'sessionIndex', 'snapshot']);
    expect(sessionIndexSnapshotQueryOptions('transport-b', 'runtime-a').queryKey)
      .toEqual(['transport-b', 'sessionIndex', 'snapshot']);
  });

  test('drops older runtime entries instead of skipping the write when over budget', () => {
    const storage = memoryStorage();
    const bulky = (revision: number, directory: string): SessionIndexSnapshot => ({
      ...snapshot(revision, directory),
      directories: [{ ...snapshot(revision, directory).directories[0]!, directory: directory + 'x'.repeat(400_000) }],
    });
    writeSessionIndexStartupSnapshot('runtime-old-a', bulky(1, '/a'), storage);
    writeSessionIndexStartupSnapshot('runtime-old-b', bulky(2, '/b'), storage);
    writeSessionIndexStartupSnapshot('runtime-current', bulky(3, '/c'), storage);

    expect(readSessionIndexStartupSnapshot('runtime-current', storage)?.revision).toBe(3);
    expect(readSessionIndexStartupSnapshot('runtime-old-a', storage)).toBeNull();
    expect(readSessionIndexStartupSnapshot('runtime-old-b', storage)?.revision).toBe(2);
  });

  test('isolates startup storage by runtimeKey and ignores malformed values', () => {
    const storage = memoryStorage();
    writeSessionIndexStartupSnapshot('runtime-a', snapshot(1, '/a'), storage);
    writeSessionIndexStartupSnapshot('runtime-b', snapshot(2, '/b'), storage);

    expect(readSessionIndexStartupSnapshot('runtime-a', storage)).toEqual(snapshot(1, '/a'));
    expect(readSessionIndexStartupSnapshot('runtime-b', storage)).toEqual(snapshot(2, '/b'));
    expect(readSessionIndexStartupSnapshot('runtime-c', storage)).toBeNull();
    expect(readSessionIndexStartupSnapshot('runtime-c', memoryStorage('{bad json'))).toBeNull();
    expect(readSessionIndexStartupSnapshot(
      'runtime-c',
      memoryStorage(JSON.stringify({
        version: 1,
        entries: { 'runtime-c': { revision: 'x', sync: {}, directories: [] } },
      })),
    )).toBeNull();
    expect(readSessionIndexStartupSnapshot(
      'runtime-c',
      memoryStorage(JSON.stringify({
        version: 1,
        entries: {
          'runtime-c': {
            revision: 1,
            sync: {
              active: false,
              completed: 0,
              total: 0,
              pendingDirectories: [],
              completedDirectories: [],
              failedDirectories: [],
            },
            directories: [{
              directory: '/repo',
              cursor: null,
              hasMore: false,
              lastSyncedAt: 1,
              lastFullSyncedAt: 1,
              lastAccessedAt: 1,
              sessions: [{}],
            }],
          },
        },
      })),
    )).toBeNull();
  });

  test('exposes a cold startup snapshot immediately, marks it stale, and retains it after revalidation failure', async () => {
    const storage = memoryStorage();
    writeSessionIndexStartupSnapshot('runtime-a', snapshot(3, '/cached'), storage);
    const load = async (): Promise<SessionIndexSnapshot | null> => {
      throw new Error('offline');
    };
    const options = sessionIndexSnapshotQueryOptions('transport-a', 'runtime-a', storage, load);
    const query = client.getQueryCache().build(client, options);

    expect(query.state.data).toEqual(snapshot(3, '/cached'));
    expect(query.state.dataUpdatedAt).toBe(0);
    await expect(client.fetchQuery(options)).rejects.toThrow('offline');
    expect(readSessionIndexSnapshotQuery(client, 'transport-a')).toEqual(snapshot(3, '/cached'));
  });

  test('reuses one runtimeKey startup snapshot across direct and relay Query transports', () => {
    const storage = memoryStorage();
    writeSessionIndexStartupSnapshot('host:paired-server', snapshot(6, '/paired'), storage);

    const direct = client.getQueryCache().build(
      client,
      sessionIndexSnapshotQueryOptions('direct:url:http://lan.example', 'host:paired-server', storage),
    );
    const relay = client.getQueryCache().build(
      client,
      sessionIndexSnapshotQueryOptions('relay:{"serverId":"server-1"}', 'host:paired-server', storage),
    );

    expect(direct.state.data).toEqual(snapshot(6, '/paired'));
    expect(relay.state.data).toEqual(snapshot(6, '/paired'));
  });

  test('persists successful live snapshots under the matching runtimeKey and never writes null', async () => {
    const storage = memoryStorage();
    writeSessionIndexStartupSnapshot('runtime-a', snapshot(1, '/stale'), storage);
    await client.fetchQuery(sessionIndexSnapshotQueryOptions(
      'transport-a',
      'runtime-a',
      storage,
      async () => snapshot(9, '/fresh'),
    ));

    expect(readSessionIndexStartupSnapshot('runtime-a', storage)).toEqual(snapshot(9, '/fresh'));
    expect(readSessionIndexStartupSnapshot('runtime-b', storage)).toBeNull();

    const result = await client.fetchQuery(sessionIndexSnapshotQueryOptions(
      'transport-a',
      'runtime-a',
      storage,
      async () => null,
    ));
    expect(result).toBeNull();
    // null (501/unsupported) must not overwrite the last successful storage seed.
    expect(readSessionIndexStartupSnapshot('runtime-a', storage)).toEqual(snapshot(9, '/fresh'));
  });

  test('seed builds initialData without network; ensure/refresh share fetch and write cache', async () => {
    const storage = memoryStorage();
    writeSessionIndexStartupSnapshot('runtime-a', snapshot(4, '/seed'), storage);
    let calls = 0;
    const load = async (): Promise<SessionIndexSnapshot | null> => {
      calls += 1;
      return snapshot(5, '/live');
    };

    const seeded = seedSessionIndexSnapshotQuery(client, 'transport-a', 'runtime-a', storage);
    expect(seeded).toEqual(snapshot(4, '/seed'));
    expect(calls).toBe(0);

    const first = ensureSessionIndexSnapshotQuery(client, 'transport-a', 'runtime-a', storage, load);
    const second = ensureSessionIndexSnapshotQuery(client, 'transport-a', 'runtime-a', storage, load);
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(readSessionIndexSnapshotQuery(client, 'transport-a')).toEqual(snapshot(5, '/live'));
    expect(readSessionIndexStartupSnapshot('runtime-a', storage)).toEqual(snapshot(5, '/live'));

    await refreshSessionIndexSnapshotQuery(client, 'transport-a', 'runtime-a', storage, load);
    expect(calls).toBe(2);
  });

  test('writeSessionIndexSnapshotQuery updates Query memory and optional storage', () => {
    const storage = memoryStorage();
    writeSessionIndexSnapshotQuery(snapshot(7, '/manual'), {
      client,
      transport: 'transport-a',
      runtimeKey: 'runtime-a',
      storage,
    });
    expect(readSessionIndexSnapshotQuery(client, 'transport-a')).toEqual(snapshot(7, '/manual'));
    expect(readSessionIndexStartupSnapshot('runtime-a', storage)).toEqual(snapshot(7, '/manual'));
  });

  test('passes the Query AbortSignal to the runtime snapshot loader', async () => {
    let receivedSignal: AbortSignal | undefined;
    const options = sessionIndexSnapshotQueryOptions(
      'transport-a',
      'runtime-a',
      memoryStorage(),
      async (requestOptions) => {
        receivedSignal = requestOptions?.signal;
        return snapshot();
      },
    );
    const controller = new AbortController();

    await options.queryFn({ signal: controller.signal });

    expect(receivedSignal).toBe(controller.signal);
  });

  test('shares a completed revision across observers but fetches newer tips and invalidations', async () => {
    const storage = memoryStorage();
    let calls = 0, revision = 2;
    const load = async () => { calls++; return snapshot(revision); };
    await refreshSessionIndexSnapshotQuery(client, 'transport-a', 'runtime-a', storage, load);
    for (let i = 0; i < 128; i++) {
      expect((await ensureSessionIndexRevisionQuery(2, client, 'transport-a', 'runtime-a', storage, load))?.revision).toBe(2);
    }
    expect(calls).toBe(1);
    revision = 3;
    await Promise.all(Array.from({ length: 8 }, () => ensureSessionIndexRevisionQuery(3, client, 'transport-a', 'runtime-a', storage, load)));
    expect(calls).toBe(2);
    await client.invalidateQueries({ queryKey: sessionIndexSnapshotQueryOptions('transport-a').queryKey });
    await ensureSessionIndexRevisionQuery(3, client, 'transport-a', 'runtime-a', storage, load);
    expect(calls).toBe(3);
    await refreshSessionIndexSnapshotQuery(client, 'transport-a', 'runtime-a', storage, load);
    expect(calls).toBe(4);
  });

  test('revision reuse never trusts persistent seeds, another transport, or failed refreshes', async () => {
    const storage = memoryStorage();
    writeSessionIndexStartupSnapshot('runtime-a', snapshot(20), storage);
    seedSessionIndexSnapshotQuery(client, 'transport-a', 'runtime-a', storage);
    let calls = 0;
    const load = async () => { calls++; return snapshot(21); };
    await ensureSessionIndexRevisionQuery(20, client, 'transport-a', 'runtime-a', storage, load);
    await ensureSessionIndexRevisionQuery(20, client, 'transport-b', 'runtime-a', storage, load);
    expect(calls).toBe(2);
    await expect(ensureSessionIndexRevisionQuery(22, client, 'transport-a', 'runtime-a', storage, async () => {
      throw new Error('offline');
    })).rejects.toThrow('offline');
    expect(readSessionIndexSnapshotQuery(client, 'transport-a')?.revision).toBe(21);
    await ensureSessionIndexRevisionQuery(22, client, 'transport-a', 'runtime-a', storage, load);
    expect(calls).toBe(3);
  });
});
