import { describe, expect, test, vi } from 'vitest';

import {
  AUTO_CONNECT_ATTEMPT_TIMEOUT_MS,
  initialAutoConnectPhase,
  nextAutoConnectPhase,
  raceAutoConnectAttempt,
  resolveLynxConnectGate,
  shouldAttemptAutoConnect,
} from './autoConnectPhase';

describe('Lynx auto-connect gate', () => {
  test('splash while attempting, welcome when done unconnected', () => {
    expect(resolveLynxConnectGate({
      phase: 'attempting',
      connected: false,
      autoConnectLabel: 'home-lan',
    })).toEqual({ kind: 'splash', phase: 'attempting', label: 'home-lan' });

    expect(resolveLynxConnectGate({
      phase: 'done',
      connected: false,
    })).toEqual({ kind: 'welcome' });

    expect(resolveLynxConnectGate({
      phase: 'done',
      connected: true,
    })).toEqual({ kind: 'connected' });
  });

  test('phase machine pending → attempting → done', () => {
    expect(nextAutoConnectPhase('pending', 'start')).toBe('attempting');
    expect(nextAutoConnectPhase('attempting', 'finish')).toBe('done');
    expect(nextAutoConnectPhase('done', 'start')).toBe('done');
  });

  test('initial phase skips splash without saved token or when skipAutoConnect', () => {
    expect(initialAutoConnectPhase({ skipAutoConnect: true, hasSavedToken: true })).toBe('done');
    expect(initialAutoConnectPhase({ skipAutoConnect: false, hasSavedToken: false })).toBe('done');
    expect(initialAutoConnectPhase({ skipAutoConnect: false, hasSavedToken: true })).toBe('pending');
  });

  test('shouldAttemptAutoConnect only when token exists and not skipped', () => {
    expect(shouldAttemptAutoConnect({ skipAutoConnect: true, hasSavedToken: true })).toBe(false);
    expect(shouldAttemptAutoConnect({ skipAutoConnect: false, hasSavedToken: false })).toBe(false);
    expect(shouldAttemptAutoConnect({ skipAutoConnect: false, hasSavedToken: true })).toBe(true);
  });

  test('raceAutoConnectAttempt returns success before timeout', async () => {
    await expect(raceAutoConnectAttempt(Promise.resolve(true), 50)).resolves.toBe(true);
    await expect(raceAutoConnectAttempt(Promise.resolve(false), 50)).resolves.toBe(false);
  });

  test('raceAutoConnectAttempt times out hanging attempt → false (welcome path)', async () => {
    vi.useFakeTimers();
    try {
      const hanging = new Promise<boolean>(() => {});
      const raced = raceAutoConnectAttempt(hanging, AUTO_CONNECT_ATTEMPT_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(AUTO_CONNECT_ATTEMPT_TIMEOUT_MS);
      await expect(raced).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('raceAutoConnectAttempt treats reject as false', async () => {
    await expect(
      raceAutoConnectAttempt(Promise.reject(new Error('probe-failed')), 50),
    ).resolves.toBe(false);
  });
});
