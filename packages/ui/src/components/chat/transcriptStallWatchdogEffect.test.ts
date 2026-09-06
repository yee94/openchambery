import { describe, expect, test } from 'vitest';

import {
  INITIAL_TRANSCRIPT_STALL_STATE,
  type TranscriptStallState,
} from './transcriptStallWatchdog';
import {
  resetTranscriptStallStateForInactive,
  shouldArmTranscriptStallWatchdog,
} from './transcriptStallWatchdogEffect';

describe('shouldArmTranscriptStallWatchdog', () => {
  test('arms only for the active working surface', () => {
    expect(shouldArmTranscriptStallWatchdog({
      active: true,
      sessionId: 'ses_a',
      sessionKey: '/repo\nses_a',
      sessionIsWorking: true,
    })).toBe(true);

    expect(shouldArmTranscriptStallWatchdog({
      active: false,
      sessionId: 'ses_a',
      sessionKey: '/repo\nses_a',
      sessionIsWorking: true,
    })).toBe(false);

    expect(shouldArmTranscriptStallWatchdog({
      active: true,
      sessionId: 'ses_a',
      sessionKey: '/repo\nses_a',
      sessionIsWorking: false,
    })).toBe(false);

    expect(shouldArmTranscriptStallWatchdog({
      active: true,
      sessionId: null,
      sessionKey: null,
      sessionIsWorking: true,
    })).toBe(false);
  });
});

describe('resetTranscriptStallStateForInactive', () => {
  test('clears stall history so reactivate does not inherit a near-threshold clock', () => {
    const dirty: TranscriptStallState = {
      sessionKey: '/repo\nses_a',
      fingerprint: 'frozen',
      lastMovementAt: 1,
      lastRefreshAt: 2,
      attempts: 2,
    };
    expect(resetTranscriptStallStateForInactive(dirty)).toEqual(INITIAL_TRANSCRIPT_STALL_STATE);
    expect(resetTranscriptStallStateForInactive(INITIAL_TRANSCRIPT_STALL_STATE))
      .toBe(INITIAL_TRANSCRIPT_STALL_STATE);
  });
});

describe('ChatContainer stall watchdog active gate (source contract)', () => {
  test('effect depends on active and uses the shared arm helper', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'ChatContainer.tsx'),
      'utf8',
    );
    expect(source).toContain('shouldArmTranscriptStallWatchdog');
    expect(source).toContain('resetTranscriptStallStateForInactive');
    expect(source).toContain('active,');
    const effectStart = source.indexOf('shouldArmTranscriptStallWatchdog({');
    expect(effectStart).toBeGreaterThan(-1);
    const effectSlice = source.slice(effectStart, effectStart + 800);
    expect(effectSlice).toContain('active,');
    expect(effectSlice).toContain('sessionIsWorking');
  });
});
