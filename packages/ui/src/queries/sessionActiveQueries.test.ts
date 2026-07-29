import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import {
  fetchSessionActiveSnapshot,
  sessionActiveSnapshotQueryOptions,
  type SessionActiveRuntimeProbe,
} from './sessionActiveQueries';
import type { SessionActiveResult } from '@/lib/opencode/client';

const createClient = (): QueryClient => new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const runtimeProbe = (
  transport = 'transport-a',
  generation = 1,
): SessionActiveRuntimeProbe => ({
  getTransport: () => transport,
  getGeneration: () => generation,
});

describe('sessionActiveQueries', () => {
  test('isolates transport + generation keys and is process-global (no directory)', () => {
    const first = sessionActiveSnapshotQueryOptions({
      transport: 'transport-a',
      runtimeProbe: runtimeProbe('transport-a', 1),
    });
    const second = sessionActiveSnapshotQueryOptions({
      transport: 'transport-b',
      runtimeProbe: runtimeProbe('transport-b', 1),
    });
    const third = sessionActiveSnapshotQueryOptions({
      transport: 'transport-a',
      runtimeProbe: runtimeProbe('transport-a', 2),
    });

    expect(first.queryKey).toEqual(['transport-a', 'sessionActive', 'snapshot', 1]);
    expect(second.queryKey).toEqual(['transport-b', 'sessionActive', 'snapshot', 1]);
    expect(third.queryKey).toEqual(['transport-a', 'sessionActive', 'snapshot', 2]);
  });

  test('shares one in-flight active request across multi-directory reconnect callers', async () => {
    const client = createClient();
    const probe = runtimeProbe();
    let calls = 0;
    let clockCalls = 0;
    let receivedSignal: AbortSignal | undefined;
    let resolveActive: ((result: SessionActiveResult) => void) | undefined;
    const loadActive = (signal?: AbortSignal) => {
      calls += 1;
      receivedSignal = signal;
      return new Promise<SessionActiveResult>((resolve) => {
        resolveActive = resolve;
      });
    };
    const options = {
      client,
      transport: 'transport-a',
      runtimeProbe: probe,
      loadActive,
      now: () => {
        clockCalls += 1;
        return 100;
      },
    };

    const first = fetchSessionActiveSnapshot(options);
    const second = fetchSessionActiveSnapshot(options);
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(clockCalls).toBe(1);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);

    resolveActive?.({ state: 'supported', membership: { ses_a: { type: 'running' } } });
    const [firstObservation, secondObservation] = await Promise.all([first, second]);

    expect(firstObservation).toBe(secondObservation);
    expect(firstObservation.requestedAt).toBe(100);
    expect(firstObservation.result).toEqual({
      state: 'supported',
      membership: { ses_a: { type: 'running' } },
    });
  });

  test('same transport with a new generation does not reuse old in-flight or cache', async () => {
    const client = createClient();
    let generation = 1;
    let calls = 0;
    let resolveGen1: ((result: SessionActiveResult) => void) | undefined;
    let resolveGen2: ((result: SessionActiveResult) => void) | undefined;
    const probe: SessionActiveRuntimeProbe = {
      getTransport: () => 'transport-a',
      getGeneration: () => generation,
    };

    const gen1 = fetchSessionActiveSnapshot({
      client,
      transport: 'transport-a',
      runtimeProbe: probe,
      loadActive: () => {
        calls += 1;
        return new Promise<SessionActiveResult>((resolve) => {
          resolveGen1 = resolve;
        });
      },
      now: () => 100,
    });
    await Promise.resolve();
    expect(calls).toBe(1);

    // Advance generation while gen1 is still in flight — same transport.
    generation = 2;
    const gen2 = fetchSessionActiveSnapshot({
      client,
      transport: 'transport-a',
      runtimeProbe: probe,
      loadActive: () => {
        calls += 1;
        return new Promise<SessionActiveResult>((resolve) => {
          resolveGen2 = resolve;
        });
      },
      now: () => 200,
    });
    await Promise.resolve();

    // Distinct generation keys → a second request is issued; no cache reuse.
    expect(calls).toBe(2);

    // Old completion is rejected by assertRuntimeCurrent (generation mismatch).
    resolveGen1?.({ state: 'supported', membership: { ses_old: { type: 'running' } } });
    await expect(gen1).rejects.toThrow('session active runtime changed');

    // New generation completes and commits normally.
    resolveGen2?.({ state: 'supported', membership: { ses_new: { type: 'running' } } });
    const observation = await gen2;
    expect(observation.requestedAt).toBe(200);
    expect(observation.result).toEqual({
      state: 'supported',
      membership: { ses_new: { type: 'running' } },
    });
  });

  test('rejects a completion from an older runtime generation', async () => {
    const client = createClient();
    let generation = 1;
    let resolveActive: ((result: SessionActiveResult) => void) | undefined;
    const probe: SessionActiveRuntimeProbe = {
      getTransport: () => 'transport-a',
      getGeneration: () => generation,
    };
    const request = fetchSessionActiveSnapshot({
      client,
      transport: 'transport-a',
      runtimeProbe: probe,
      loadActive: () => new Promise<SessionActiveResult>((resolve) => {
        resolveActive = resolve;
      }),
    });
    await Promise.resolve();

    generation = 2;
    resolveActive?.({ state: 'supported', membership: {} });

    await expect(request).rejects.toThrow('session active runtime changed');
  });
});
