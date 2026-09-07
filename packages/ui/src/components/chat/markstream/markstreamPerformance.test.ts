import { describe, expect, test } from 'vitest';

import { MARKSTREAM_CHAT_STREAM_PERFORMANCE } from './markstreamPerformance';

describe('MARKSTREAM_CHAT_STREAM_PERFORMANCE', () => {
  test('disables the in-bubble sliding window so TanStack owns row height', () => {
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.maxLiveNodes).toBe(0);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.liveNodeBuffer).toBe(0);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.typewriter).toBe(false);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.fade).toBe(false);
  });

  test('turns off typewriter batch / defer knobs that maxLiveNodes=0 would otherwise enable', () => {
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.batchRendering).toBe(false);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.smoothStreaming).toBe(false);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.deferNodesUntilVisible).toBe(false);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.viewportPriority).toBe(false);
  });
});
