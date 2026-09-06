import { describe, expect, test } from 'vitest';

import {
  clampLynxBackProgress,
  resolveLynxPredictiveBackPolicy,
  LYNX_PREDICTIVE_BACK_WIRING_NOTES,
} from './predictiveBack';

describe('predictive back contract', () => {
  test('host owns edge by default; lynx owns during composer swipe', () => {
    expect(resolveLynxPredictiveBackPolicy({ secondaryVisible: true }).owner).toBe('host');
    expect(resolveLynxPredictiveBackPolicy({
      secondaryVisible: true,
      composerSessionSwipeActive: true,
    }).owner).toBe('lynx');
  });

  test('clamps progress and documents wiring', () => {
    expect(clampLynxBackProgress(1.5)).toBe(1);
    expect(clampLynxBackProgress(-1)).toBe(0);
    expect(LYNX_PREDICTIVE_BACK_WIRING_NOTES.length).toBeGreaterThan(0);
  });
});
