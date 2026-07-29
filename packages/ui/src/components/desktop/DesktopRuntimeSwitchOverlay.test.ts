import { describe, expect, test } from 'bun:test';
import {
  DESKTOP_RUNTIME_SWITCH_MIN_DURATION_MS,
  getDesktopRuntimeSwitchRemainingMs,
} from './desktopRuntimeSwitchOverlayTiming';

describe('desktop runtime switch overlay timing', () => {
  test('waits for runtime readiness', () => {
    expect(getDesktopRuntimeSwitchRemainingMs(1_000, 2_000, false)).toBeNull();
  });

  test('keeps the overlay visible for its minimum duration', () => {
    expect(getDesktopRuntimeSwitchRemainingMs(1_000, 1_100, true)).toBe(
      DESKTOP_RUNTIME_SWITCH_MIN_DURATION_MS - 100,
    );
    expect(getDesktopRuntimeSwitchRemainingMs(1_000, 2_000, true)).toBe(0);
  });
});
