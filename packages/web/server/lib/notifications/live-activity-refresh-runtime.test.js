import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LIVE_ACTIVITY_REFRESH_DEFAULT_INTERVAL_MS,
  computeLiveActivityRefreshSnapshot,
  createLiveActivityRefreshRuntime,
  resolveLiveActivityRefreshIntervalMs,
} from './live-activity-refresh-runtime.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('resolveLiveActivityRefreshIntervalMs', () => {
  it('defaults to 30s', () => {
    expect(resolveLiveActivityRefreshIntervalMs({})).toBe(LIVE_ACTIVITY_REFRESH_DEFAULT_INTERVAL_MS);
    expect(resolveLiveActivityRefreshIntervalMs({
      OPENCHAMBER_LIVE_ACTIVITY_REFRESH_INTERVAL_MS: '  ',
    })).toBe(LIVE_ACTIVITY_REFRESH_DEFAULT_INTERVAL_MS);
  });

  it('honours explicit overrides including disable', () => {
    expect(resolveLiveActivityRefreshIntervalMs({
      OPENCHAMBER_LIVE_ACTIVITY_REFRESH_INTERVAL_MS: '45000',
    })).toBe(45_000);
    expect(resolveLiveActivityRefreshIntervalMs({
      OPENCHAMBER_LIVE_ACTIVITY_REFRESH_INTERVAL_MS: '0',
    })).toBe(0);
  });

  it('falls back to the default for invalid values', () => {
    expect(resolveLiveActivityRefreshIntervalMs({
      OPENCHAMBER_LIVE_ACTIVITY_REFRESH_INTERVAL_MS: 'abc',
    })).toBe(LIVE_ACTIVITY_REFRESH_DEFAULT_INTERVAL_MS);
    expect(resolveLiveActivityRefreshIntervalMs({
      OPENCHAMBER_LIVE_ACTIVITY_REFRESH_INTERVAL_MS: '-5',
    })).toBe(LIVE_ACTIVITY_REFRESH_DEFAULT_INTERVAL_MS);
  });
});

describe('computeLiveActivityRefreshSnapshot', () => {
  const baseInput = (overrides = {}) => ({
    entry: { token: 't', sessionId: 'live', snapshot: [] },
    sessionStates: {},
    resolveSession: async () => null,
    nowMs: 1_700_000_000_000,
    ...overrides,
  });

  it('maps idle to complete with endedAt and marks the snapshot changed', async () => {
    const result = await computeLiveActivityRefreshSnapshot(baseInput({
      entry: {
        token: 't',
        sessionId: 'live',
        snapshot: [{ sessionId: 'ses_1', title: 'One', status: 'working', startedAt: 1 }],
      },
      sessionStates: { ses_1: { status: 'idle' } },
    }));
    expect(result).toEqual({
      items: [{
        sessionId: 'ses_1',
        title: 'One',
        status: 'complete',
        startedAt: 1,
        endedAt: Math.floor(1_700_000_000_000 / 1000),
      }],
    });
  });

  it('keeps server-side-only sub-states while the session stays busy', async () => {
    const snapshot = [{ sessionId: 'ses_1', title: 'One', status: 'permission', startedAt: 1 }];
    const result = await computeLiveActivityRefreshSnapshot(baseInput({
      entry: { token: 't', sessionId: 'live', snapshot },
      sessionStates: { ses_1: { status: 'busy' } },
    }));
    expect(result).toBeNull();
  });

  it('recovers stale rows to working while busy', async () => {
    const result = await computeLiveActivityRefreshSnapshot(baseInput({
      entry: {
        token: 't',
        sessionId: 'live',
        snapshot: [{ sessionId: 'ses_1', title: 'One', status: 'stale', startedAt: 1 }],
      },
      sessionStates: { ses_1: { status: 'busy' } },
    }));
    expect(result?.items[0].status).toBe('working');
  });

  it('maps retry sessions to the retry row status', async () => {
    const result = await computeLiveActivityRefreshSnapshot(baseInput({
      entry: {
        token: 't',
        sessionId: 'live',
        snapshot: [{ sessionId: 'ses_1', title: 'One', status: 'working', startedAt: 1 }],
      },
      sessionStates: { ses_1: { status: 'retry' } },
    }));
    expect(result?.items[0].status).toBe('retry');
  });

  it('preserves rows whose session has no authoritative server state', async () => {
    const snapshot = [{ sessionId: 'ses_gone', title: 'Gone', status: 'working', startedAt: 1 }];
    const result = await computeLiveActivityRefreshSnapshot(baseInput({
      entry: { token: 't', sessionId: 'live', snapshot },
      sessionStates: {},
    }));
    expect(result).toBeNull();
  });

  it('adds new busy sessions only when the resolver marks them visible', async () => {
    const resolveSession = vi.fn(async (sessionId) => (
      sessionId === 'ses_child'
        ? { title: 'Child', visible: false }
        : { title: 'New Task', visible: true }
    ));
    const result = await computeLiveActivityRefreshSnapshot(baseInput({
      entry: { token: 't', sessionId: 'live', snapshot: [] },
      sessionStates: {
        ses_new: { status: 'busy' },
        ses_child: { status: 'busy' },
        ses_idle: { status: 'idle' },
      },
      resolveSession,
    }));
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]).toMatchObject({ sessionId: 'ses_new', title: 'New Task', status: 'working' });
    expect(resolveSession).not.toHaveBeenCalledWith('ses_idle');
  });

  it('skips new sessions when the resolver throws or resolves empty', async () => {
    const result = await computeLiveActivityRefreshSnapshot(baseInput({
      entry: { token: 't', sessionId: 'live', snapshot: [] },
      sessionStates: { ses_new: { status: 'busy' } },
      resolveSession: async () => {
        throw new Error('boom');
      },
    }));
    expect(result).toBeNull();
  });

  it('caps merged rows at the catalog limit, working rows first', async () => {
    const snapshot = [1, 2, 3, 4, 5].map((n) => ({
      sessionId: `ses_${n}`,
      title: `S${n}`,
      status: 'complete',
      startedAt: n,
      endedAt: n,
    }));
    const result = await computeLiveActivityRefreshSnapshot(baseInput({
      entry: { token: 't', sessionId: 'live', snapshot },
      sessionStates: { ses_new: { status: 'busy' } },
      resolveSession: async () => ({ title: 'New', visible: true }),
    }));
    expect(result?.items).toHaveLength(4);
    expect(result?.items.some((item) => item.sessionId === 'ses_new')).toBe(true);
    // Most recently settled rows survive the cap.
    expect(result?.items.some((item) => item.sessionId === 'ses_5')).toBe(true);
    expect(result?.items.some((item) => item.sessionId === 'ses_1')).toBe(false);
  });

  it('returns null when nothing changed', async () => {
    const snapshot = [
      { sessionId: 'ses_1', title: 'One', status: 'working', startedAt: 1 },
      { sessionId: 'ses_2', title: 'Two', status: 'complete', startedAt: 2, endedAt: 3 },
    ];
    const result = await computeLiveActivityRefreshSnapshot(baseInput({
      entry: { token: 't', sessionId: 'live', snapshot },
      sessionStates: { ses_1: { status: 'busy' } },
    }));
    expect(result).toBeNull();
  });
});

describe('createLiveActivityRefreshRuntime', () => {
  it('ticks the refresh with one session-state snapshot for all entries', async () => {
    const refreshLiveActivityTokens = vi.fn(async () => {});
    const runtime = createLiveActivityRefreshRuntime({
      intervalMs: LIVE_ACTIVITY_REFRESH_DEFAULT_INTERVAL_MS,
      refreshLiveActivityTokens,
      getSessionStateSnapshot: () => ({ ses_1: { status: 'busy' } }),
      resolveSession: async () => null,
    });
    await runtime.tick();

    expect(refreshLiveActivityTokens).toHaveBeenCalledTimes(1);
    const arg = refreshLiveActivityTokens.mock.calls[0][0];
    expect(typeof arg.computeSnapshot).toBe('function');
    const result = await arg.computeSnapshot({
      token: 't',
      sessionId: 'live',
      snapshot: [{ sessionId: 'ses_1', title: 'One', status: 'working', startedAt: 1 }],
    });
    expect(result).toBeNull();
  });

  it('drops overlapping ticks instead of queueing them', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const refreshLiveActivityTokens = vi.fn(async () => { await gate; });
    const runtime = createLiveActivityRefreshRuntime({
      intervalMs: 1000,
      refreshLiveActivityTokens,
      getSessionStateSnapshot: () => ({}),
      resolveSession: async () => null,
    });
    const first = runtime.tick();
    await runtime.tick(); // overlapping → dropped
    release();
    await first;
    expect(refreshLiveActivityTokens).toHaveBeenCalledTimes(1);
  });

  it('never schedules a timer when disabled (interval 0) and disposes cleanly', async () => {
    vi.useFakeTimers();
    const refreshLiveActivityTokens = vi.fn(async () => {});
    const runtime = createLiveActivityRefreshRuntime({
      intervalMs: 0,
      refreshLiveActivityTokens,
      getSessionStateSnapshot: () => ({}),
      resolveSession: async () => null,
    });
    runtime.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refreshLiveActivityTokens).not.toHaveBeenCalled();

    const enabled = createLiveActivityRefreshRuntime({
      intervalMs: 30_000,
      refreshLiveActivityTokens,
      getSessionStateSnapshot: () => ({}),
      resolveSession: async () => null,
    });
    enabled.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshLiveActivityTokens).toHaveBeenCalledTimes(1);
    enabled.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refreshLiveActivityTokens).toHaveBeenCalledTimes(1);
  });
});
