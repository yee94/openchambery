import { describe, expect, test } from 'bun:test';
import { resolveStreamingRenderCadence } from './streamingRenderCadence';

describe('streaming render cadence', () => {
  test('uses the Android native cadence', () => {
    expect(resolveStreamingRenderCadence('android')).toEqual({
      textThrottleMs: 100,
      markdownPaceMs: 128,
    });
  });

  test('preserves the existing cadence on other platforms', () => {
    expect(resolveStreamingRenderCadence('web')).toEqual({
      textThrottleMs: 20,
      markdownPaceMs: 64,
    });
    expect(resolveStreamingRenderCadence('ios')).toEqual({
      textThrottleMs: 20,
      markdownPaceMs: 64,
    });
  });
});
