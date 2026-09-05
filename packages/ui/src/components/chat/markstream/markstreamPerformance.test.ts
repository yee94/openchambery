import { describe, expect, test } from 'vitest';

import { MARKSTREAM_CHAT_STREAM_PERFORMANCE } from './markstreamPerformance';

describe('MARKSTREAM_CHAT_STREAM_PERFORMANCE', () => {
  test('keeps the in-document virtual window on (not typewriter maxLiveNodes=0)', () => {
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.maxLiveNodes).toBe(320);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.liveNodeBuffer).toBe(60);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.maxLiveNodes).toBeGreaterThan(0);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.typewriter).toBe(false);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.fade).toBe(false);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.smoothStreaming).toBe('auto');
  });

  test('uses the documented AI-chat batch / defer knobs', () => {
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.batchRendering).toBe(true);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.deferNodesUntilVisible).toBe(true);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.viewportPriority).toBe(true);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.initialRenderBatchSize).toBe(40);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.renderBatchSize).toBe(80);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.renderBatchDelay).toBe(16);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.renderBatchBudgetMs).toBe(6);
    expect(MARKSTREAM_CHAT_STREAM_PERFORMANCE.renderBatchIdleTimeoutMs).toBe(120);
  });
});
