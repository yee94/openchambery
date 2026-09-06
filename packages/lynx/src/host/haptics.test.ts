import { describe, expect, test } from 'vitest';

import {
  LYNX_HAPTICS_CONTRACT,
  applyLynxEdgeSwipeHaptic,
  createLynxHapticsAdapter,
  resolveLynxHapticMethod,
} from './haptics';

describe('LynxHapticsAdapter', () => {
  test('maps Cap strengths to OpenChamberHaptics methods', () => {
    expect(resolveLynxHapticMethod('light')).toBe('impactLight');
    expect(resolveLynxHapticMethod('medium')).toBe('impactMedium');
    expect(resolveLynxHapticMethod('heavy')).toBe('impactHeavy');
    expect(LYNX_HAPTICS_CONTRACT.pluginName).toBe('OpenChamberHaptics');
  });

  test('no host → unavailable, never fake-success', async () => {
    const adapter = createLynxHapticsAdapter();
    expect(adapter.isAvailable()).toBe(false);
    expect(await adapter.impact('light')).toEqual({
      status: 'unavailable',
      reason: 'no-host',
    });
    expect(await applyLynxEdgeSwipeHaptic(adapter, 'medium')).toBe(false);
  });

  test('host inject fires matching method', async () => {
    const calls: string[] = [];
    const adapter = createLynxHapticsAdapter();
    adapter.inject({
      impactLight: async () => { calls.push('light'); },
      impactMedium: async () => { calls.push('medium'); },
      impactHeavy: async () => { calls.push('heavy'); },
    });
    expect(await adapter.impact('medium')).toEqual({ status: 'ok', strength: 'medium' });
    expect(calls).toEqual(['medium']);
  });
});
