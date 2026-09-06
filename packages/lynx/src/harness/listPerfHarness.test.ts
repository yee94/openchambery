import { describe, expect, test } from 'vitest';

import {
  assertHarnessCadenceMatchesCapNotes,
  CAP_STREAMING_RENDER_CADENCE,
  resolveLynxStreamingCadenceNotes,
  runLynxListPerfHarness,
} from './listPerfHarness';

describe('Lynx list performance harness', () => {
  test('Cap cadence notes match streamingRenderCadence.ts (not device numbers)', () => {
    expect(resolveLynxStreamingCadenceNotes('default')).toEqual({
      textThrottleMs: 20,
      markdownPaceMs: 64,
      source: 'Cap streamingRenderCadence.ts (default/ios)',
    });
    expect(resolveLynxStreamingCadenceNotes('android')).toEqual({
      textThrottleMs: 100,
      markdownPaceMs: 128,
      source: 'Cap streamingRenderCadence.ts (android)',
    });
    expect(CAP_STREAMING_RENDER_CADENCE.default.textThrottleMs).toBe(20);
  });

  test('synthetic clock records streaming cadence; prepend keeps anchor; never deviceMeasured', () => {
    const result = runLynxListPerfHarness({
      streamUpdates: 5,
      streamIntervalMs: CAP_STREAMING_RENDER_CADENCE.default.textThrottleMs,
      platform: 'default',
    });
    expect(result.deviceMeasured).toBe(false);
    expect(result.meanStreamingDeltaMs).toBe(20);
    expect(result.prependKeptAnchor).toBe(true);
    expect(result.samples.length).toBe(6); // seed + 5
    assertHarnessCadenceMatchesCapNotes(result, 20);

    const android = runLynxListPerfHarness({
      streamUpdates: 3,
      streamIntervalMs: CAP_STREAMING_RENDER_CADENCE.android.textThrottleMs,
      platform: 'android',
    });
    expect(android.meanStreamingDeltaMs).toBe(100);
    expect(android.capCadenceNotes.textThrottleMs).toBe(100);
  });
});
