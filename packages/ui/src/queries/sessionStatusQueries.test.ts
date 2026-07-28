import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import {
  fetchDirectorySessionStatusSnapshot,
  sessionStatusSnapshotQueryOptions,
  type SessionStatusRuntimeProbe,
} from './sessionStatusQueries';

const createClient = (): QueryClient => new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const runtimeProbe = (
  transport = 'transport-a',
  generation = 1,
): SessionStatusRuntimeProbe => ({
  getTransport: () => transport,
  getGeneration: () => generation,
});

describe('sessionStatusQueries', () => {
  test('normalizes directory keys and isolates transport entries', () => {
    const first = sessionStatusSnapshotQueryOptions('/repo ', {
      transport: 'transport-a',
      runtimeProbe: runtimeProbe('transport-a'),
    });
    const second = sessionStatusSnapshotQueryOptions('/repo', {
      transport: 'transport-b',
      runtimeProbe: runtimeProbe('transport-b'),
    });

    expect(first.queryKey).toEqual(['transport-a', 'sessionStatus', 'snapshot', '/repo']);
    expect(second.queryKey).toEqual(['transport-b', 'sessionStatus', 'snapshot', '/repo']);
  });

  test('shares one in-flight directory request and one request-start boundary', async () => {
    const client = createClient();
    const probe = runtimeProbe();
    let calls = 0;
    let clockCalls = 0;
    let receivedSignal: AbortSignal | undefined;
    let resolveSnapshot: ((snapshot: Record<string, { type: 'busy' }>) => void) | undefined;
    const loadSnapshot = (_directory: string, signal?: AbortSignal) => {
      calls += 1;
      receivedSignal = signal;
      return new Promise<Record<string, { type: 'busy' }>>((resolve) => {
        resolveSnapshot = resolve;
      });
    };
    const options = {
      client,
      transport: 'transport-a',
      runtimeProbe: probe,
      loadSnapshot,
      now: () => {
        clockCalls += 1;
        return 100;
      },
    };

    const first = fetchDirectorySessionStatusSnapshot('/repo', options);
    const second = fetchDirectorySessionStatusSnapshot('/repo', options);
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(clockCalls).toBe(1);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);

    resolveSnapshot?.({ ses_a: { type: 'busy' } });
    const [firstObservation, secondObservation] = await Promise.all([first, second]);

    expect(firstObservation).toBe(secondObservation);
    expect(firstObservation.requestedAt).toBe(100);
    expect(firstObservation.snapshot).toEqual({ ses_a: { type: 'busy' } });
  });

  test('keeps directory requests isolated', async () => {
    const client = createClient();
    const calls: string[] = [];
    const loadSnapshot = async (directory: string) => {
      calls.push(directory);
      return {};
    };

    await Promise.all([
      fetchDirectorySessionStatusSnapshot('/a', {
        client,
        transport: 'transport-a',
        runtimeProbe: runtimeProbe(),
        loadSnapshot,
      }),
      fetchDirectorySessionStatusSnapshot('/b', {
        client,
        transport: 'transport-a',
        runtimeProbe: runtimeProbe(),
        loadSnapshot,
      }),
    ]);

    expect(calls.sort()).toEqual(['/a', '/b']);
  });

  test('preserves the last successful Query snapshot when refresh fails', async () => {
    const client = createClient();
    const probe = runtimeProbe();
    const successful = await fetchDirectorySessionStatusSnapshot('/repo', {
      client,
      transport: 'transport-a',
      runtimeProbe: probe,
      loadSnapshot: async () => ({ ses_a: { type: 'busy' } }),
      now: () => 10,
    });
    const queryKey = sessionStatusSnapshotQueryOptions('/repo', {
      transport: 'transport-a',
      runtimeProbe: probe,
    }).queryKey;

    await expect(fetchDirectorySessionStatusSnapshot('/repo', {
      client,
      transport: 'transport-a',
      runtimeProbe: probe,
      loadSnapshot: async () => null,
      now: () => 20,
    })).rejects.toThrow('session status snapshot unavailable');

    expect(client.getQueryData(queryKey)).toBe(successful);
  });

  test('rejects a completion from an older runtime generation', async () => {
    const client = createClient();
    let generation = 1;
    let resolveSnapshot: ((snapshot: Record<string, never>) => void) | undefined;
    const probe: SessionStatusRuntimeProbe = {
      getTransport: () => 'transport-a',
      getGeneration: () => generation,
    };
    const request = fetchDirectorySessionStatusSnapshot('/repo', {
      client,
      transport: 'transport-a',
      runtimeProbe: probe,
      loadSnapshot: () => new Promise<Record<string, never>>((resolve) => {
        resolveSnapshot = resolve;
      }),
    });
    await Promise.resolve();

    generation = 2;
    resolveSnapshot?.({});

    await expect(request).rejects.toThrow('session status runtime changed');
  });
});
