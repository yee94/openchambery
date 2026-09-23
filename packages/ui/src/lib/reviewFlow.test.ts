import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Message } from '@/lib/opencode/v2-types';

// Boundary: reviewFlow only needs getRuntimeKey for runtime-guard helpers.
// Real switchRuntimeEndpoint mints url-auth + dispatches endpoint-changed, which
// fans into store listeners and happy-dom network (ECONNREFUSED :3000 /
// ENOTFOUND) and leaves pending fetch tasks that fail environment teardown.
const runtime = vi.hoisted(() => {
  const state = { key: 'runtime-a' };
  const settledFetch = (async () =>
    new Response(JSON.stringify({ token: 'review-flow-test-url-token', expiresAt: Date.now() + 120_000 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  // Hoisted before static imports so module-load side effects cannot open real sockets.
  vi.stubGlobal('fetch', settledFetch);
  return { state, settledFetch };
});

vi.mock('@/lib/runtime-switch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime-switch')>();
  return {
    ...actual,
    getRuntimeKey: () => runtime.state.key,
  };
});

import {
  assertAutoReviewRuntimeStillCurrent,
  claimAutoReviewForward,
  releaseAutoReviewForward,
  hasFinalReviewMarker,
  isAutoReviewRuntimeCurrent,
  isExpectedAutoReviewAssistantParent,
  stripFinalReviewMarker,
} from './reviewFlow';
import type { AutoReviewRun } from '@/stores/useAutoReviewStore';

describe('reviewFlow auto-review helpers', () => {
  beforeEach(() => {
    runtime.state.key = 'runtime-a';
    // happy-dom keeps a window-bound Fetch; keep it settled for the whole case.
    vi.stubGlobal('fetch', runtime.settledFetch);
    if (typeof window !== 'undefined') {
      try {
        window.fetch = runtime.settledFetch;
      } catch {
        // Some environments expose a non-writable window.fetch.
      }
    }
  });

  afterEach(() => {
    runtime.state.key = 'runtime-a';
  });

  test('detects and strips final review marker only from the final line', () => {
    const text = 'No remaining issues.\n\nFINAL_REVIEW_STATUS: no_remaining_findings\n';

    expect(hasFinalReviewMarker(text)).toBe(true);
    expect(stripFinalReviewMarker(text)).toBe('No remaining issues.');
  });

  test('detects and strips final review marker case-insensitively', () => {
    const text = 'No findings.\nFINAL_REVIEW_STATUS: no_remaining_findINGS\n';

    expect(hasFinalReviewMarker(text)).toBe(true);
    expect(stripFinalReviewMarker(text)).toBe('No findings.');
  });

  test('does not treat quoted or non-final marker text as completion', () => {
    const text = 'The marker is FINAL_REVIEW_STATUS: no_remaining_findings, but issues remain.';

    expect(hasFinalReviewMarker(text)).toBe(false);
    expect(stripFinalReviewMarker(text)).toBe(text);
  });

  test('requires assistant parent to match the auto-sent user message when provided', () => {
    const matching = { id: 'msg_assistant_1', parentID: 'msg_user_auto' } as Message;
    const unrelated = { id: 'msg_assistant_2', parentID: 'msg_user_manual' } as Message;

    expect(isExpectedAutoReviewAssistantParent(matching, 'msg_user_auto')).toBe(true);
    expect(isExpectedAutoReviewAssistantParent(unrelated, 'msg_user_auto')).toBe(false);
    expect(isExpectedAutoReviewAssistantParent(unrelated)).toBe(true);
  });

  test('runtime guard rejects runs from a stale runtime', () => {
    expect(isAutoReviewRuntimeCurrent('runtime-a')).toBe(true);
    runtime.state.key = 'runtime-b';
    expect(isAutoReviewRuntimeCurrent('runtime-a')).toBe(false);
    expect(() => assertAutoReviewRuntimeStillCurrent('runtime-a')).toThrow('runtime changed');
  });

  test('claims only one in-flight forward for the same auto-review message', () => {
    const run: AutoReviewRun = {
      originalSessionID: 'original-1',
      reviewSessionID: 'review-1',
      directory: '/workspace',
      runtimeKey: 'runtime-a',
      status: 'running',
      phase: 'waiting_for_reviewer',
      iteration: 0,
      maxIterations: 15,
      expectedAssistantParentID: 'msg_user_prompt',
    };

    const key = claimAutoReviewForward(run, 'msg_assistant_review');

    expect(typeof key).toBe('string');
    expect(claimAutoReviewForward(run, 'msg_assistant_review')).toBeNull();

    releaseAutoReviewForward(key!);
    const nextKey = claimAutoReviewForward(run, 'msg_assistant_review');
    expect(nextKey).toBe(key);
    releaseAutoReviewForward(nextKey!);
  });
});
