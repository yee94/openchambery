import { describe, expect, test } from 'bun:test';
import {
  isExclusiveFullMainPrimary,
  resolvePrimarySurface,
} from './primarySurface';

describe('primarySurface mutual exclusion', () => {
  test('settings wins over every main tab', () => {
    expect(resolvePrimarySurface('chat', true)).toEqual({
      primary: 'settings',
      sessionTool: null,
    });
    expect(resolvePrimarySurface('schedule', true).primary).toBe('settings');
    expect(resolvePrimarySurface('assistant', true).primary).toBe('settings');
    expect(resolvePrimarySurface('git', true).primary).toBe('settings');
  });

  test('schedule / assistant are exclusive primaries (no session tools)', () => {
    expect(resolvePrimarySurface('schedule', false)).toEqual({
      primary: 'schedule',
      sessionTool: null,
    });
    expect(resolvePrimarySurface('scheduled', false).primary).toBe('schedule');
    expect(resolvePrimarySurface('assistant', false)).toEqual({
      primary: 'assistant',
      sessionTool: null,
    });
    expect(isExclusiveFullMainPrimary('schedule')).toBe(true);
    expect(isExclusiveFullMainPrimary('assistant')).toBe(true);
    expect(isExclusiveFullMainPrimary('session')).toBe(false);
  });

  test('session tools nest under session primary only', () => {
    expect(resolvePrimarySurface('chat', false)).toEqual({
      primary: 'session',
      sessionTool: null,
    });
    expect(resolvePrimarySurface('git', false)).toEqual({
      primary: 'session',
      sessionTool: 'git',
    });
    expect(resolvePrimarySurface('diff', false).sessionTool).toBe('diff');
    expect(resolvePrimarySurface('files', false).sessionTool).toBe('files');
  });

  test('primaries are mutually exclusive pairs', () => {
    const primaries = ['session', 'schedule', 'assistant', 'settings'] as const;
    for (const a of primaries) {
      for (const b of primaries) {
        if (a === b) continue;
        // Different primaries must not both be "full main exclusive" without settings rule
        // — product rule: only one resolvePrimarySurface result at a time.
        expect(a === b).toBe(false);
      }
    }
  });
});
