import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

import {
  applyNativeLiveActivityCommand,
  createInitialNativeLiveActivityState,
  evaluateNativeIosLiveActivityAvailability,
  mapNativeLiveActivityPhase,
  NATIVE_LIVE_ACTIVITY_BUSY_START_MS,
  NATIVE_LIVE_ACTIVITY_COMMAND_RETRY_MS,
  NATIVE_LIVE_ACTIVITY_COMPLETE_DISMISSAL_SECONDS,
  NATIVE_LIVE_ACTIVITY_ERROR_DISMISSAL_SECONDS,
  nextNativeLiveActivityEventVersion,
  reduceNativeLiveActivity,
  rollbackNativeLiveActivityState,
  runNativeLiveActivityStep,
  shouldScheduleNativeLiveActivityRetry,
  toNativeLiveActivityTimestamp,
  type NativeLiveActivityObservation,
  type NativeLiveActivityPlugin,
  type NativeLiveActivityState,
} from './native-ios-live-activity';

const here = dirname(fileURLToPath(import.meta.url));

const observe = (
  overrides: Partial<NativeLiveActivityObservation> = {},
): NativeLiveActivityObservation => ({
  sessionId: 'ses_a',
  statusType: 'busy',
  hasPendingPermissions: false,
  hasPendingQuestions: false,
  hasSessionError: false,
  now: 1_000,
  connected: true,
  ...overrides,
});

const reduceFrom = (
  state: NativeLiveActivityState,
  overrides: Partial<NativeLiveActivityObservation> = {},
) => reduceNativeLiveActivity(state, observe(overrides));

const startWorking = (now = NATIVE_LIVE_ACTIVITY_BUSY_START_MS) => {
  const waiting = reduceFrom(createInitialNativeLiveActivityState(), { now: 0 });
  return reduceNativeLiveActivity(waiting.state, observe({ now, statusType: 'busy' }));
};

const plugin = (): NativeLiveActivityPlugin => ({
  isSupported: vi.fn(async () => ({ supported: true })),
  start: vi.fn(async () => ({ activityId: 'act_1' })),
  update: vi.fn(async () => undefined),
  end: vi.fn(async () => undefined),
});

describe('native iOS Live Activity availability', () => {
  test('is available only on Capacitor iOS with the plugin registered', () => {
    expect(evaluateNativeIosLiveActivityAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: true,
    })).toBe(true);
    expect(evaluateNativeIosLiveActivityAvailability({
      isCapacitor: true,
      platform: 'android',
      pluginAvailable: true,
    })).toBe(false);
    expect(evaluateNativeIosLiveActivityAvailability({
      isCapacitor: false,
      platform: 'ios',
      pluginAvailable: true,
    })).toBe(false);
    expect(evaluateNativeIosLiveActivityAvailability({
      isCapacitor: true,
      platform: 'web',
      pluginAvailable: true,
    })).toBe(false);
    expect(evaluateNativeIosLiveActivityAvailability({
      isCapacitor: false,
      platform: 'desktop',
      pluginAvailable: true,
    })).toBe(false);
    expect(evaluateNativeIosLiveActivityAvailability({
      isCapacitor: false,
      platform: 'vscode',
      pluginAvailable: true,
    })).toBe(false);
    expect(evaluateNativeIosLiveActivityAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: false,
    })).toBe(false);
    expect(evaluateNativeIosLiveActivityAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: true,
      nativeUiEnabled: false,
    })).toBe(false);
    expect(evaluateNativeIosLiveActivityAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: true,
      nativeUiEnabled: true,
    })).toBe(true);
  });
});

describe('mapNativeLiveActivityPhase', () => {
  test('ranks unhandled permission above question, then retry, then working', () => {
    expect(mapNativeLiveActivityPhase({
      statusType: 'retry',
      hasPendingPermissions: true,
      hasPendingQuestions: true,
      hasSessionError: true,
    })).toBe('error');
    expect(mapNativeLiveActivityPhase({
      statusType: 'retry',
      hasPendingPermissions: true,
      hasPendingQuestions: true,
    })).toBe('permission');
    expect(mapNativeLiveActivityPhase({
      statusType: 'busy',
      hasPendingPermissions: false,
      hasPendingQuestions: true,
    })).toBe('input');
    expect(mapNativeLiveActivityPhase({
      statusType: 'busy',
      hasPendingPermissions: false,
      hasPendingQuestions: false,
    })).toBe('working');
    expect(mapNativeLiveActivityPhase({
      statusType: 'retry',
      hasPendingPermissions: false,
      hasPendingQuestions: false,
    })).toBe('retry');
    expect(mapNativeLiveActivityPhase({
      statusType: 'idle',
      hasPendingPermissions: false,
      hasPendingQuestions: false,
    })).toBe('complete');
  });

  test('maps error from live session_error_at, not idle or unknown status', () => {
    expect(mapNativeLiveActivityPhase({
      statusType: 'idle',
      hasPendingPermissions: false,
      hasPendingQuestions: false,
      hasSessionError: true,
    })).toBe('error');
    expect(mapNativeLiveActivityPhase({
      statusType: 'idle',
      hasPendingPermissions: false,
      hasPendingQuestions: false,
    })).not.toBe('error');
    expect(mapNativeLiveActivityPhase({
      statusType: 'unknown',
      hasPendingPermissions: false,
      hasPendingQuestions: false,
    })).toBeNull();
    expect(mapNativeLiveActivityPhase({
      statusType: undefined,
      hasPendingPermissions: false,
      hasPendingQuestions: false,
    })).toBeNull();
    expect(mapNativeLiveActivityPhase({
      statusType: 'busy',
      hasPendingPermissions: false,
      hasPendingQuestions: false,
    })).not.toBe('tool');
    expect(mapNativeLiveActivityPhase({
      statusType: 'idle',
      hasPendingPermissions: false,
      hasPendingQuestions: false,
    })).not.toBe('stale');
  });
});

describe('reduceNativeLiveActivity', () => {
  test('waits 5s of continuous busy before start and keeps first busy time as startedAt', () => {
    const first = reduceFrom(createInitialNativeLiveActivityState(), { now: 100 });
    expect(first.commands).toEqual([{ type: 'wait', delayMs: NATIVE_LIVE_ACTIVITY_BUSY_START_MS }]);
    expect(first.state.started).toBe(false);
    expect(first.state.busySince).toBe(100);

    const mid = reduceNativeLiveActivity(first.state, observe({ now: 100 + 2_000 }));
    expect(mid.commands).toEqual([{ type: 'wait', delayMs: 3_000 }]);
    expect(mid.state.busySince).toBe(100);

    const early = reduceNativeLiveActivity(first.state, observe({ now: 100 + 4_999 }));
    expect(early.commands[0]).toMatchObject({ type: 'wait' });
    expect(early.state.started).toBe(false);

    const startedAtNow = 100 + NATIVE_LIVE_ACTIVITY_BUSY_START_MS;
    const started = reduceNativeLiveActivity(first.state, observe({ now: startedAtNow }));
    expect(started.commands).toHaveLength(1);
    expect(started.commands[0]).toMatchObject({
      type: 'start',
      payload: {
        sessionId: 'ses_a',
        startedAt: 100,
        status: 'working',
        eventVersion: nextNativeLiveActivityEventVersion(startedAtNow, 0),
        updatedAt: startedAtNow,
      },
    });
    expect(started.state.started).toBe(true);
  });

  test('starts retry immediately and reuses the first busy observation as startedAt', () => {
    const busy = reduceFrom(createInitialNativeLiveActivityState(), { now: 50, statusType: 'busy' });
    const retry = reduceNativeLiveActivity(busy.state, observe({ now: 80, statusType: 'retry' }));
    expect(retry.commands).toEqual([{
      type: 'start',
      payload: {
        sessionId: 'ses_a',
        startedAt: 50,
        status: 'retry',
        eventVersion: nextNativeLiveActivityEventVersion(80, 0),
        updatedAt: 80,
      },
    }]);
  });

  test('starts permission and question immediately, with permission winning', () => {
    const permission = reduceFrom(createInitialNativeLiveActivityState(), {
      now: 10,
      statusType: 'idle',
      hasPendingPermissions: true,
      hasPendingQuestions: true,
    });
    expect(permission.commands[0]).toMatchObject({
      type: 'start',
      payload: {
        status: 'permission',
        eventVersion: nextNativeLiveActivityEventVersion(10, 0),
        startedAt: 10,
      },
    });

    const question = reduceFrom(createInitialNativeLiveActivityState(), {
      now: 10,
      statusType: 'busy',
      hasPendingQuestions: true,
    });
    expect(question.commands[0]).toMatchObject({
      type: 'start',
      payload: { status: 'input', eventVersion: nextNativeLiveActivityEventVersion(10, 0) },
    });
  });

  test('does not start on idle or unknown before an activity exists', () => {
    expect(reduceFrom(createInitialNativeLiveActivityState(), { statusType: 'idle' }).commands).toEqual([]);
    expect(reduceFrom(createInitialNativeLiveActivityState(), { statusType: 'error' }).commands).toEqual([]);
    expect(reduceFrom(createInitialNativeLiveActivityState(), { statusType: undefined }).commands).toEqual([]);
  });

  test('dedupes identical phases and increments eventVersion on changes', () => {
    const started = startWorking();
    const startVersion = nextNativeLiveActivityEventVersion(NATIVE_LIVE_ACTIVITY_BUSY_START_MS, 0);
    const same = reduceNativeLiveActivity(started.state, observe({
      now: NATIVE_LIVE_ACTIVITY_BUSY_START_MS + 1,
      statusType: 'busy',
    }));
    expect(same.commands).toEqual([]);
    expect(same.state.eventVersion).toBe(startVersion);

    const retryNow = NATIVE_LIVE_ACTIVITY_BUSY_START_MS + 2;
    const retry = reduceNativeLiveActivity(started.state, observe({
      now: retryNow,
      statusType: 'retry',
    }));
    expect(retry.commands[0]).toMatchObject({
      type: 'update',
      payload: {
        status: 'retry',
        eventVersion: nextNativeLiveActivityEventVersion(retryNow, startVersion),
      },
    });

    const permissionNow = NATIVE_LIVE_ACTIVITY_BUSY_START_MS + 3;
    const permission = reduceNativeLiveActivity(retry.state, observe({
      now: permissionNow,
      statusType: 'retry',
      hasPendingPermissions: true,
    }));
    expect(permission.commands[0]).toMatchObject({
      type: 'update',
      payload: {
        status: 'permission',
        eventVersion: nextNativeLiveActivityEventVersion(permissionNow, retry.state.eventVersion),
      },
    });
  });

  test('maps idle after start to complete and ends with 900s dismissal', () => {
    const started = startWorking();
    const ended = reduceNativeLiveActivity(started.state, observe({
      now: 20_000,
      statusType: 'idle',
    }));
    expect(ended.commands).toEqual([{
      type: 'end',
      payload: {
        sessionId: 'ses_a',
        startedAt: 0,
        status: 'complete',
        eventVersion: nextNativeLiveActivityEventVersion(20_000, started.state.eventVersion),
        updatedAt: 20_000,
        endedAt: 20_000,
        dismissalSeconds: NATIVE_LIVE_ACTIVITY_COMPLETE_DISMISSAL_SECONDS,
      },
    }]);
    expect(ended.state.started).toBe(false);
  });

  test('maps explicit error after start and ends with 3600s dismissal', () => {
    const started = startWorking();
    const ended = reduceNativeLiveActivity(started.state, observe({
      now: 20_000,
      statusType: 'idle',
      hasSessionError: true,
    }));
    expect(ended.commands[0]).toMatchObject({
      type: 'end',
      payload: {
        status: 'error',
        eventVersion: nextNativeLiveActivityEventVersion(20_000, started.state.eventVersion),
        dismissalSeconds: NATIVE_LIVE_ACTIVITY_ERROR_DISMISSAL_SECONDS,
        endedAt: 20_000,
      },
    });
  });

  test('ends the old activity when the selected session changes', () => {
    const started = startWorking();
    const switched = reduceNativeLiveActivity(started.state, observe({
      sessionId: 'ses_b',
      now: 20_000,
      statusType: 'busy',
    }));
    expect(switched.commands[0]).toMatchObject({
      type: 'end',
      payload: {
        sessionId: 'ses_a',
        dismissalSeconds: 0,
        eventVersion: nextNativeLiveActivityEventVersion(20_000, started.state.eventVersion),
      },
    });
    expect(switched.commands[1]).toMatchObject({ type: 'wait' });
    expect(switched.state.trackedSessionId).toBe('ses_b');
    expect(switched.state.started).toBe(false);
  });

  test('clears a pending busy timer on disconnect without starting', () => {
    const waiting = reduceFrom(createInitialNativeLiveActivityState(), { now: 0 });
    const disconnected = reduceNativeLiveActivity(waiting.state, observe({ connected: false, now: 2_000 }));
    expect(disconnected.commands).toEqual([]);
    expect(disconnected.state.busySince).toBeNull();
    expect(disconnected.state.started).toBe(false);
  });

  test('maps live session error after start to error end', () => {
    const started = startWorking();
    const ended = reduceNativeLiveActivity(started.state, observe({
      now: 20_000,
      statusType: 'idle',
      hasSessionError: true,
      errorAt: 19_000,
    }));
    expect(ended.commands[0]).toMatchObject({
      type: 'end',
      payload: {
        status: 'error',
        dismissalSeconds: NATIVE_LIVE_ACTIVITY_ERROR_DISMISSAL_SECONDS,
      },
    });
    expect(ended.state.started).toBe(false);
  });

  test('busy after error restores working once the activity is running', () => {
    const started = startWorking();
    const errored = reduceNativeLiveActivity(started.state, observe({
      now: 20_000,
      statusType: 'idle',
      hasSessionError: true,
    }));
    expect(errored.state.started).toBe(false);
    const retried = reduceNativeLiveActivity(createInitialNativeLiveActivityState(), observe({
      now: 21_000,
      statusType: 'busy',
      hasSessionError: false,
    }));
    expect(retried.commands[0]).toMatchObject({ type: 'wait' });
  });

  test('disconnect updates a running activity to stale once, then zero-calls', () => {
    const started = startWorking();
    const disconnected = reduceNativeLiveActivity(started.state, observe({
      connected: false,
      now: 20_000,
    }));
    expect(disconnected.commands).toHaveLength(1);
    expect(disconnected.commands[0]).toMatchObject({
      type: 'update',
      payload: { status: 'stale', sessionId: 'ses_a' },
    });
    expect(disconnected.state.started).toBe(true);
    expect(disconnected.state.lastStatus).toBe('stale');
    expect(disconnected.state.busySince).toBeNull();

    const again = reduceNativeLiveActivity(disconnected.state, observe({
      connected: false,
      now: 21_000,
    }));
    expect(again.commands).toEqual([]);
    expect(again.state.lastStatus).toBe('stale');
  });

  test('reconnect after stale restores the current authoritative phase', () => {
    const started = startWorking();
    const stale = reduceNativeLiveActivity(started.state, observe({
      connected: false,
      now: 20_000,
    }));
    const restored = reduceNativeLiveActivity(stale.state, observe({
      connected: true,
      now: 21_000,
      statusType: 'retry',
    }));
    expect(restored.commands[0]).toMatchObject({
      type: 'update',
      payload: { status: 'retry' },
    });
    expect(restored.state.started).toBe(true);
    expect(restored.state.lastStatus).toBe('retry');

    const permission = reduceNativeLiveActivity(stale.state, observe({
      connected: true,
      now: 21_000,
      statusType: 'busy',
      hasPendingPermissions: true,
    }));
    expect(permission.commands[0]).toMatchObject({
      type: 'update',
      payload: { status: 'permission' },
    });
  });

  test('idle during the 5s window never starts', () => {
    const waiting = reduceFrom(createInitialNativeLiveActivityState(), { now: 0 });
    const idle = reduceNativeLiveActivity(waiting.state, observe({ now: 2_000, statusType: 'idle' }));
    expect(idle.commands).toEqual([]);
    expect(idle.state.started).toBe(false);
    expect(idle.state.busySince).toBeNull();
  });

  test('restart versions are far above the old 1-based counter', () => {
    const oldSmallCounter = 3;
    const now = 1_700_000_012_456;
    const started = reduceFrom(createInitialNativeLiveActivityState(), {
      now,
      statusType: 'retry',
    });
    const version = started.commands[0];
    expect(version).toMatchObject({ type: 'start' });
    if (version?.type !== 'start') return;
    expect(version.payload.eventVersion).toBe(Math.floor(now));
    expect(version.payload.eventVersion).toBeGreaterThan(oldSmallCounter);
    expect(version.payload.eventVersion).toBe(nextNativeLiveActivityEventVersion(now, 0));
  });

  test('consecutive semantic changes in the same millisecond still increment', () => {
    const now = 1_700_000_000_123;
    const started = reduceFrom(createInitialNativeLiveActivityState(), {
      now,
      statusType: 'retry',
    });
    expect(started.commands[0]).toMatchObject({
      type: 'start',
      payload: { eventVersion: now },
    });

    const permission = reduceNativeLiveActivity(started.state, observe({
      now,
      statusType: 'retry',
      hasPendingPermissions: true,
    }));
    expect(permission.commands[0]).toMatchObject({
      type: 'update',
      payload: { status: 'permission', eventVersion: now + 1 },
    });

    const question = reduceNativeLiveActivity(permission.state, observe({
      now,
      statusType: 'retry',
      hasPendingQuestions: true,
    }));
    expect(question.commands[0]).toMatchObject({
      type: 'update',
      payload: { status: 'input', eventVersion: now + 2 },
    });
  });
});

describe('applyNativeLiveActivityCommand', () => {
  test('does not call the plugin when unavailable (web/electron/vscode/Android zero-call)', async () => {
    const native = plugin();
    await applyNativeLiveActivityCommand(false, native, {
      type: 'start',
      payload: {
        sessionId: 'ses_a',
        startedAt: 1_000,
        status: 'working',
        eventVersion: 1,
        updatedAt: 13_000,
      },
    });
    await applyNativeLiveActivityCommand(false, native, {
      type: 'update',
      payload: {
        sessionId: 'ses_a',
        startedAt: 1_000,
        status: 'retry',
        eventVersion: 2,
        updatedAt: 14_000,
      },
    });
    await applyNativeLiveActivityCommand(false, native, {
      type: 'end',
      payload: {
        sessionId: 'ses_a',
        startedAt: 1_000,
        status: 'complete',
        eventVersion: 3,
        updatedAt: 15_000,
        endedAt: 15_000,
        dismissalSeconds: 900,
      },
    });
    expect(native.isSupported).not.toHaveBeenCalled();
    expect(native.start).not.toHaveBeenCalled();
    expect(native.update).not.toHaveBeenCalled();
    expect(native.end).not.toHaveBeenCalled();
  });

  test('forwards flattened fields and converts timestamps to unix seconds', async () => {
    const native = plugin();
    await applyNativeLiveActivityCommand(true, native, {
      type: 'start',
      payload: {
        sessionId: 'ses_a',
        startedAt: 1_700_000_000_000,
        status: 'working',
        eventVersion: 1,
        updatedAt: 1_700_000_012_000,
      },
    });
    expect(native.start).toHaveBeenCalledWith({
      sessionId: 'ses_a',
      startedAt: toNativeLiveActivityTimestamp(1_700_000_000_000),
      status: 'working',
      eventVersion: 1,
      updatedAt: toNativeLiveActivityTimestamp(1_700_000_012_000),
    });
    await applyNativeLiveActivityCommand(true, native, {
      type: 'end',
      payload: {
        sessionId: 'ses_a',
        startedAt: 1_700_000_000_000,
        status: 'complete',
        eventVersion: 2,
        updatedAt: 1_700_000_020_000,
        endedAt: 1_700_000_020_000,
        dismissalSeconds: 900,
      },
    });
    expect(native.end).toHaveBeenCalledWith({
      sessionId: 'ses_a',
      startedAt: toNativeLiveActivityTimestamp(1_700_000_000_000),
      status: 'complete',
      eventVersion: 2,
      updatedAt: toNativeLiveActivityTimestamp(1_700_000_020_000),
      endedAt: toNativeLiveActivityTimestamp(1_700_000_020_000),
      dismissalSeconds: 900,
    });
  });
});

describe('native Live Activity command failure', () => {
  test('rolls back only when the failed epoch is still current', () => {
    const previous = createInitialNativeLiveActivityState();
    const current: NativeLiveActivityState = {
      ...previous,
      started: true,
      trackedSessionId: 'ses_a',
      lastStatus: 'working',
      eventVersion: 1_700_000_000_000,
    };
    expect(rollbackNativeLiveActivityState({
      failedEpoch: 1,
      currentEpoch: 1,
      previous,
      current,
    })).toBe(previous);
    expect(rollbackNativeLiveActivityState({
      failedEpoch: 1,
      currentEpoch: 2,
      previous,
      current,
    })).toBe(current);
  });

  test('schedules one retry only for the current failed epoch', () => {
    expect(shouldScheduleNativeLiveActivityRetry({
      failedEpoch: 1,
      currentEpoch: 1,
      retryCount: 0,
    })).toBe(true);
    expect(shouldScheduleNativeLiveActivityRetry({
      failedEpoch: 1,
      currentEpoch: 1,
      retryCount: 1,
    })).toBe(false);
    expect(shouldScheduleNativeLiveActivityRetry({
      failedEpoch: 1,
      currentEpoch: 2,
      retryCount: 0,
    })).toBe(false);
  });

  test('start failure rolls back to not-started and asks for a short retry', async () => {
    const native = plugin();
    native.start = vi.fn(async () => {
      throw new Error('start failed');
    });
    const previous = createInitialNativeLiveActivityState();
    const result = await runNativeLiveActivityStep({
      available: true,
      plugin: native,
      state: previous,
      observation: observe({ now: 80, statusType: 'retry' }),
      epoch: 1,
      getCurrentEpoch: () => 1,
      retryCount: 0,
    });
    expect(result.state.started).toBe(false);
    expect(result.state).toEqual(previous);
    expect(result.retry).toBe(true);
    expect(result.delayMs).toBe(NATIVE_LIVE_ACTIVITY_COMMAND_RETRY_MS);
  });

  test('a stale failure does not overwrite a newer observation', async () => {
    const native = plugin();
    native.start = vi.fn(async () => {
      throw new Error('start failed');
    });
    const previous = createInitialNativeLiveActivityState();
    const result = await runNativeLiveActivityStep({
      available: true,
      plugin: native,
      state: previous,
      observation: observe({ now: 80, statusType: 'retry' }),
      epoch: 1,
      getCurrentEpoch: () => 2,
      retryCount: 0,
    });
    expect(result.retry).toBe(false);
    expect(result.delayMs).toBeNull();
    expect(result.superseded).toBe(true);
    expect(result.state).toEqual(previous);
    expect(result.state.started).toBe(false);
  });

  test('success after a newer epoch/session does not commit the old observation', async () => {
    const native = plugin();
    let currentEpoch = 1;
    let currentSession: string | null = 'ses_a';
    native.start = vi.fn(async () => {
      currentEpoch = 2;
      currentSession = 'ses_b';
      return { activityId: 'act_1' };
    });
    const previous = createInitialNativeLiveActivityState();
    const result = await runNativeLiveActivityStep({
      available: true,
      plugin: native,
      state: previous,
      observation: observe({ now: 80, statusType: 'retry' }),
      epoch: 1,
      getCurrentEpoch: () => currentEpoch,
      getCurrentSessionId: () => currentSession,
      retryCount: 0,
    });
    expect(result.superseded).toBe(true);
    expect(result.state).toEqual(previous);
    expect(result.state.started).toBe(false);
  });

  test('does not retry after the bounded first attempt', async () => {
    const native = plugin();
    native.start = vi.fn(async () => {
      throw new Error('start failed');
    });
    const result = await runNativeLiveActivityStep({
      available: true,
      plugin: native,
      state: createInitialNativeLiveActivityState(),
      observation: observe({ now: 80, statusType: 'retry' }),
      epoch: 4,
      getCurrentEpoch: () => 4,
      retryCount: 1,
    });
    expect(result.retry).toBe(false);
    expect(result.delayMs).toBeNull();
    expect(result.state.started).toBe(false);
  });

  test('end-then-start: a failed start rolls back to the post-end checkpoint', async () => {
    const native = plugin();
    native.end = vi.fn(async () => undefined);
    native.start = vi.fn(async () => {
      throw new Error('start failed');
    });
    const started = startWorking(1_700_000_012_000);
    const result = await runNativeLiveActivityStep({
      available: true,
      plugin: native,
      state: started.state,
      observation: observe({
        sessionId: 'ses_b',
        now: 1_700_000_020_000,
        statusType: 'retry',
      }),
      epoch: 1,
      getCurrentEpoch: () => 1,
      retryCount: 0,
    });
    expect(native.end).toHaveBeenCalledOnce();
    expect(native.start).toHaveBeenCalledOnce();
    expect(result.state.started).toBe(false);
    expect(result.state.trackedSessionId).toBeNull();
    expect(result.retry).toBe(true);
  });
});

describe('useNativeLiveActivity wiring', () => {
  test('uses the narrow live status and bootstrap:false permission/question hooks', () => {
    const hook = readFileSync(join(here, '../apps/useNativeLiveActivity.ts'), 'utf-8');
    const syncContext = readFileSync(join(here, '../sync/sync-context.tsx'), 'utf-8');
    expect(syncContext).toContain('export function useSessionErrorAt');
    expect(syncContext).toContain('state.session_error_at?.[sessionID] !== previous.session_error_at?.[sessionID]');
    expect(hook).toContain('useLiveSessionStatus');
    expect(hook).toContain('useSessionErrorAt');
    expect(hook).toContain('hasSessionError');
    expect(hook).toContain('errorAt');
    expect(hook).toContain('useSessionPermissions');
    expect(hook).toContain('useSessionQuestions');
    expect(hook).toContain("{ bootstrap: false }");
    expect(hook).toContain('getCurrentSessionId');
    expect(hook).toContain('result.superseded');
    expect(hook).not.toContain('useCallback');
    expect(hook).toContain('useEvent');
    expect(hook).not.toContain('useSessionMessages');
    expect(hook).not.toContain('message.part');
    expect(hook).toContain('runNativeLiveActivityStep');
    expect(hook).toContain('epochRef');
    expect(hook).not.toContain('applyNativeLiveActivityCommand(true, plugin, command).catch(() => undefined)');
    const app = readFileSync(join(here, '../apps/MobileApp.tsx'), 'utf-8');
    expect(app).toContain('useNativeLiveActivity');
    expect(app).toContain('sessionId: currentSessionId');
  });
});
