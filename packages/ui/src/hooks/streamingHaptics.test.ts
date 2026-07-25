import { describe, expect, test } from 'bun:test';
import {
  evaluateHaptics,
  evaluateSwipeThresholdHaptic,
  isCapacitorMobileNative,
  isCapacitorNativePlatform,
  resolveMobileHapticMethod,
  shouldTriggerHaptic,
  type HapticsInput,
} from './streamingHaptics';
import {
  createStreamingHapticEventDeduper,
  evaluateVisiblePartHaptic,
  shouldEmitToolAppearanceHaptic,
  type StreamingHapticEvent,
} from '../sync/streaming-haptic-events';

const baseInput = (overrides: Partial<HapticsInput> = {}): HapticsInput => ({
  eventSessionId: 'session-1',
  currentSessionId: 'session-1',
  isForeground: true,
  isVisible: true,
  ...overrides,
});

describe('streaming haptic platform checks', () => {
  test('returns false when window is undefined', () => {
    // @ts-expect-error testing SSR / undefined window
    globalThis.window = undefined;
    expect(isCapacitorNativePlatform()).toBe(false);
  });

  test('returns false outside the Capacitor shell', () => {
    expect(isCapacitorMobileNative()).toBe(false);
  });
});

describe('evaluateHaptics', () => {
  test('fires for a visible update in the current foreground session', () => {
    expect(evaluateHaptics(baseInput())).toEqual({ shouldTrigger: true, reason: 'trigger' });
  });

  test('skips updates from another session', () => {
    expect(evaluateHaptics(baseInput({ eventSessionId: 'session-2' })).reason).toBe('different-session');
  });

  test('skips updates while backgrounded or hidden', () => {
    expect(evaluateHaptics(baseInput({ isForeground: false })).reason).toBe('background');
    expect(evaluateHaptics(baseInput({ isVisible: false })).reason).toBe('hidden');
  });
});

describe('haptic cadence', () => {
  test('allows haptics every 20ms', () => {
    expect(shouldTriggerHaptic(100, 119)).toBe(false);
    expect(shouldTriggerHaptic(100, 120)).toBe(true);
  });
});

describe('haptic strength mapping', () => {
  test('maps light, medium, and heavy to distinct native methods', () => {
    expect(resolveMobileHapticMethod('light')).toBe('impactLight');
    expect(resolveMobileHapticMethod('medium')).toBe('impactMedium');
    expect(resolveMobileHapticMethod('heavy')).toBe('impactHeavy');
  });
});

describe('swipe threshold haptics', () => {
  test('emits once when entering and once when cancelling with hysteresis', () => {
    const entered = evaluateSwipeThresholdHaptic({
      thresholdReached: false,
      distance: 64,
      enterDistance: 64,
      cancelDistance: 56,
      available: true,
    });
    expect(entered).toEqual({ thresholdReached: true, event: 'enter' });
    expect(evaluateSwipeThresholdHaptic({
      thresholdReached: true,
      distance: 60,
      enterDistance: 64,
      cancelDistance: 56,
      available: true,
    })).toEqual({ thresholdReached: true, event: null });
    expect(evaluateSwipeThresholdHaptic({
      thresholdReached: true,
      distance: 56,
      enterDistance: 64,
      cancelDistance: 56,
      available: true,
    })).toEqual({ thresholdReached: false, event: 'cancel' });
  });

  test('cancels when the swipe direction becomes unavailable', () => {
    expect(evaluateSwipeThresholdHaptic({
      thresholdReached: true,
      distance: 80,
      enterDistance: 64,
      cancelDistance: 56,
      available: false,
    })).toEqual({ thresholdReached: false, event: 'cancel' });
  });

  test('emits enter again when one continuous swipe returns across the threshold', () => {
    const entered = evaluateSwipeThresholdHaptic({
      thresholdReached: false,
      distance: 64,
      enterDistance: 64,
      cancelDistance: 56,
      available: true,
    });
    const cancelled = evaluateSwipeThresholdHaptic({
      thresholdReached: entered.thresholdReached,
      distance: 56,
      enterDistance: 64,
      cancelDistance: 56,
      available: true,
    });

    expect(evaluateSwipeThresholdHaptic({
      thresholdReached: cancelled.thresholdReached,
      distance: 64,
      enterDistance: 64,
      cancelDistance: 56,
      available: true,
    })).toEqual({ thresholdReached: true, event: 'enter' });
  });
});

describe('visible part haptic semantics', () => {
  test('fires once when reasoning first becomes visible', () => {
    const pending = evaluateVisiblePartHaptic(null, {
      identity: 'message-1:reasoning-1',
      content: '',
      isActive: true,
      mode: 'appearance',
    });
    const visible = evaluateVisiblePartHaptic(pending.nextState, {
      identity: 'message-1:reasoning-1',
      content: 'Thinking',
      isActive: false,
      mode: 'appearance',
    });
    const tokenUpdate = evaluateVisiblePartHaptic(visible.nextState, {
      identity: 'message-1:reasoning-1',
      content: 'Thinking through the change',
      isActive: false,
      mode: 'appearance',
    });

    expect(pending.shouldEmit).toBe(false);
    expect(visible.shouldEmit).toBe(true);
    expect(tokenUpdate.shouldEmit).toBe(false);
  });

  test('fires for every visible assistant text change across finalization', () => {
    const initial = evaluateVisiblePartHaptic(null, {
      identity: 'message-1:text-1',
      content: 'First',
      isActive: true,
      mode: 'changes',
    });
    const update = evaluateVisiblePartHaptic(initial.nextState, {
      identity: 'message-1:text-1',
      content: 'First update',
      isActive: true,
      mode: 'changes',
    });
    const finalUpdate = evaluateVisiblePartHaptic(update.nextState, {
      identity: 'message-1:text-1',
      content: 'First update complete',
      isActive: false,
      mode: 'changes',
    });
    const unchanged = evaluateVisiblePartHaptic(finalUpdate.nextState, {
      identity: 'message-1:text-1',
      content: 'First update complete',
      isActive: false,
      mode: 'changes',
    });

    expect(initial.shouldEmit).toBe(true);
    expect(update.shouldEmit).toBe(true);
    expect(finalUpdate.shouldEmit).toBe(true);
    expect(unchanged.shouldEmit).toBe(false);
  });

  test('keeps completed history silent on first render', () => {
    const historical = evaluateVisiblePartHaptic(null, {
      identity: 'message-1:text-1',
      content: 'Existing history',
      isActive: false,
      mode: 'changes',
    });

    expect(historical.shouldEmit).toBe(false);
  });

  test('fires delayed sorted text once after an active message lifecycle', () => {
    const delayedFinalText = evaluateVisiblePartHaptic(null, {
      identity: 'message-1:text-1',
      content: 'Final response',
      isActive: true,
      mode: 'changes',
    });

    expect(delayedFinalText.shouldEmit).toBe(true);
  });
});

describe('one-shot haptic event deduplication', () => {
  const event = (kind: StreamingHapticEvent['kind'], partID = 'part-1'): StreamingHapticEvent => ({
    sessionID: 'session-1',
    messageID: 'message-1',
    partID,
    kind,
  });

  test('deduplicates reasoning and tool appearances while preserving text updates', () => {
    const shouldProcess = createStreamingHapticEventDeduper();

    expect(shouldProcess(event('thinking'))).toBe(true);
    expect(shouldProcess(event('thinking'))).toBe(false);
    expect(shouldProcess(event('tool', 'tool-1'))).toBe(true);
    expect(shouldProcess(event('tool', 'tool-1'))).toBe(false);
    expect(shouldProcess(event('text'))).toBe(true);
    expect(shouldProcess(event('text'))).toBe(true);
  });

  test('bounds appearance history', () => {
    const shouldProcess = createStreamingHapticEventDeduper(2);

    expect(shouldProcess(event('tool', 'tool-1'))).toBe(true);
    expect(shouldProcess(event('tool', 'tool-2'))).toBe(true);
    expect(shouldProcess(event('tool', 'tool-3'))).toBe(true);
    expect(shouldProcess(event('tool', 'tool-1'))).toBe(true);
  });
});

describe('tool appearance haptic baseline', () => {
  test('keeps initial finalized tools silent and emits active or newly observed tools', () => {
    expect(shouldEmitToolAppearanceHaptic(true, false)).toBe(false);
    expect(shouldEmitToolAppearanceHaptic(true, true)).toBe(true);
    expect(shouldEmitToolAppearanceHaptic(false, false)).toBe(true);
  });
});
