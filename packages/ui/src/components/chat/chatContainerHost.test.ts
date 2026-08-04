import { describe, expect, test } from 'bun:test';
import {
    mergePendingUserMessagePresentations,
    pendingUserMessagesImplyWorking,
    resolveChatContainerHostFeatures,
    resolveChatHistoryLoadState,
    resolveChatSessionTranscriptGate,
    type ChatContainerHost,
} from './chatContainerHost';
import type { PendingUserMessagePresentation } from '@/sync/session-ui-store';

const sampleHost = (features?: ChatContainerHost['features']): ChatContainerHost => ({
  sessionId: 'ses_test',
  directory: '/workspace',
  composerSurface: { kind: 'secondary', surfaceID: 'assistant:test' } as ChatContainerHost['composerSurface'],
  sessionSurface: {
    kind: 'embedded',
    surfaceId: 'assistant:test',
    sessionId: 'ses_test',
    directory: '/workspace',
    active: true,
    capabilities: {
      compose: true,
      mutateSession: true,
      answerRequests: true,
      openTimeline: true,
      navigateNestedSession: false,
      textSelectionActions: true,
      forkSession: false,
    },
  },
  features,
});

describe('chatContainerHost', () => {
  test('keeps a pending row until its stable message ID is authoritative', () => {
    const pending = {
      info: { id: 'msg_pending', role: 'user' },
      parts: [{ type: 'text', text: 'hello' }],
    } as PendingUserMessagePresentation;
    const first = mergePendingUserMessagePresentations([], [pending]);
    expect(first).toEqual([pending]);

    const authoritative = [{
      info: { ...pending.info, sessionID: 'ses_real' },
      parts: [{ type: 'text', text: 'hello from server' }],
    }] as PendingUserMessagePresentation[];
    const reconciled = mergePendingUserMessagePresentations(authoritative, [pending]);
    expect(reconciled).toBe(authoritative);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.parts[0]).toEqual({ type: 'text', text: 'hello from server' });
  });

  test('substitutes a part-less authoritative row with its pending counterpart', () => {
    const pending = {
      info: { id: 'msg_pending', role: 'user' },
      parts: [{ type: 'text', text: 'hello' }],
    } as PendingUserMessagePresentation;
    // The row exists but its parts never landed — handing over now would paint
    // an empty bubble, so the pending row stands in without duplicating the ID.
    const partless = [{
      info: { ...pending.info, sessionID: 'ses_real' },
      parts: [],
    }] as PendingUserMessagePresentation[];

    const reconciled = mergePendingUserMessagePresentations(partless, [pending]);

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toBe(pending);
  });

  test('keeps primary-only features on when no host is provided', () => {
    expect(resolveChatContainerHostFeatures(undefined)).toEqual({
      newSessionDraft: true,
      promptNavigator: true,
      returnToParent: true,
    });
  });

  test('disables primary-only features for hosted surfaces by default', () => {
    expect(resolveChatContainerHostFeatures(sampleHost())).toEqual({
      newSessionDraft: false,
      promptNavigator: false,
      returnToParent: false,
    });
  });

  test('allows hosted surfaces to re-enable selected primary features', () => {
    expect(resolveChatContainerHostFeatures(sampleHost({ promptNavigator: true }))).toEqual({
      newSessionDraft: false,
      promptNavigator: true,
      returnToParent: false,
    });
  });

  test('stale idle (observedAt before pending created) still implies working', () => {
    const pending = [{ info: { time: { created: 2000 } } }];

    expect(pendingUserMessagesImplyWorking(pending, {
      resolvedSessionStatus: { type: 'idle' },
      sessionStatusObservedAt: 1000,
    })).toBe(true);
  });

  test('fresh idle (observedAt at/after pending created) stops implying working', () => {
    const pending = [{ info: { time: { created: 1000 } } }];

    expect(pendingUserMessagesImplyWorking(pending, {
      resolvedSessionStatus: { type: 'idle' },
      sessionStatusObservedAt: 1000,
    })).toBe(false);
    expect(pendingUserMessagesImplyWorking(pending, {
      resolvedSessionStatus: { type: 'idle' },
      sessionStatusObservedAt: 1500,
    })).toBe(false);
  });

  test('pending implies working without resolved status or observedAt', () => {
    const pending = [{ info: { time: { created: 1000 } } }];

    expect(pendingUserMessagesImplyWorking(pending, {
      resolvedSessionStatus: null,
      sessionStatusObservedAt: 2000,
    })).toBe(true);
    expect(pendingUserMessagesImplyWorking(pending, {
      resolvedSessionStatus: { type: 'idle' },
      sessionStatusObservedAt: undefined,
    })).toBe(true);
    expect(pendingUserMessagesImplyWorking([], {
      resolvedSessionStatus: null,
      sessionStatusObservedAt: undefined,
    })).toBe(false);
  });
});

describe('resolveChatHistoryLoadState', () => {
  test('default meta (incomplete, no cursor) cannot load and is not complete', () => {
    expect(resolveChatHistoryLoadState({
      syncComplete: false,
      syncHasMore: false,
      prefetchHasMore: false,
      assistantComplete: true,
    })).toEqual({ complete: false, canLoadEarlier: false });
  });

  test('live cursor enables load-more without marking complete', () => {
    expect(resolveChatHistoryLoadState({
      syncComplete: false,
      syncHasMore: true,
      prefetchHasMore: false,
      assistantComplete: true,
    })).toEqual({ complete: false, canLoadEarlier: true });
  });

  test('prefetch cursor enables load-more while live is not complete', () => {
    expect(resolveChatHistoryLoadState({
      syncComplete: false,
      syncHasMore: false,
      prefetchHasMore: true,
      assistantComplete: true,
    })).toEqual({ complete: false, canLoadEarlier: true });
  });

  test('authoritative live complete with no assistant archive is fully complete', () => {
    expect(resolveChatHistoryLoadState({
      syncComplete: true,
      syncHasMore: false,
      prefetchHasMore: false,
      assistantComplete: true,
    })).toEqual({ complete: true, canLoadEarlier: false });
  });

  test('live complete with incomplete assistant archive can still load archive pages', () => {
    expect(resolveChatHistoryLoadState({
      syncComplete: true,
      syncHasMore: false,
      prefetchHasMore: false,
      assistantComplete: false,
    })).toEqual({ complete: false, canLoadEarlier: true });
  });

  test('stale prefetch does not keep load-more after live is complete', () => {
    expect(resolveChatHistoryLoadState({
      syncComplete: true,
      syncHasMore: false,
      prefetchHasMore: true,
      assistantComplete: true,
    })).toEqual({ complete: true, canLoadEarlier: false });
  });
});

describe('resolveChatSessionTranscriptGate', () => {
  test('keeps a stable skeleton while cold or loading — never invents load-error', () => {
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: false,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: undefined,
      syncLoading: false,
    })).toBe('hydrating');

    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: false,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'loading',
      syncLoading: false,
    })).toBe('hydrating');

    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: false,
      hasRenderableSessionSnapshot: true,
      prefetchStatus: 'error',
      syncLoading: true,
    })).toBe('hydrating');
  });

  test('only surfaces load-error for a settled cold failure', () => {
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: false,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'error',
      syncLoading: false,
    })).toBe('load-error');
  });

  test('passes through when a transcript shell or ready empty snapshot exists', () => {
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: true,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'error',
      syncLoading: false,
    })).toBe('pass');

    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: false,
      hasRenderableSessionSnapshot: true,
      prefetchStatus: 'ready',
      syncLoading: false,
    })).toBe('pass');
  });
});
