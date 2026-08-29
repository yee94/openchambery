import { describe, expect, test } from 'bun:test';
import {
    mergePendingUserMessagePresentations,
    pendingUserMessagesImplyWorking,
    resolveChatContainerHostFeatures,
    resolveChatHistoryLoadState,
    resolveChatHistoryPaginationLoading,
    hasChatTranscriptShell,
    resolveChatSessionTranscriptGate,
    resolveDesktopLoadOlderStatusVisibility,
    resolveMobileLoadOlderBusy,
    resolveMobileLoadOlderVisibility,
    resolveRetainedTranscript,
    type ChatContainerHost,
} from './chatContainerHost';
import { hasUserDisplayableParts } from './message/normalizeUserDisplayParts';
import type { PendingUserMessagePresentation } from '@/sync/session-ui-store';
import type { Part } from '@opencode-ai/sdk/v2';

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

  test('substitutes synthetic-only system-reminder shells with pending text', () => {
    const pending = {
      info: { id: 'msg_pending', role: 'user' },
      parts: [{ type: 'text', text: '123123' }],
    } as PendingUserMessagePresentation;
    const systemOnly = [{
      info: { ...pending.info, sessionID: 'ses_real' },
      parts: [{
        id: 'prt_sys',
        type: 'text',
        text: '<system-reminder>\nKeep replies short.',
        synthetic: true,
      } as Part],
    }] as PendingUserMessagePresentation[];

    expect(hasUserDisplayableParts(systemOnly[0]!.parts)).toBe(false);
    const reconciled = mergePendingUserMessagePresentations(systemOnly, [pending]);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toBe(pending);
  });

  test('substitutes hollow authoritative image shells with pending counterpart', () => {
    const pending = {
      info: { id: 'msg_pending', role: 'user' },
      parts: [
        { type: 'text', text: 'with image' },
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,pending' },
      ],
    } as PendingUserMessagePresentation;
    // Server admitted the row before file URL / text landed — empty text +
    // mime-only file would otherwise paint a blank bubble and clear pending.
    const hollow = [{
      info: { ...pending.info, sessionID: 'ses_real' },
      parts: [
        { type: 'text', text: '' } as Part,
        { type: 'file', mime: 'image/png' } as Part,
      ],
    }] as PendingUserMessagePresentation[];

    expect(hasUserDisplayableParts(hollow[0]!.parts)).toBe(false);
    const reconciled = mergePendingUserMessagePresentations(hollow, [pending]);
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
  test('unknown boundary cannot load and is not complete', () => {
    expect(resolveChatHistoryLoadState({
      boundary: { kind: 'unknown', loadedTurns: 0 },
      assistantComplete: true,
    })).toEqual({ complete: false, canLoadEarlier: false });
  });

  test('has-more boundary enables load-more without marking complete', () => {
    expect(resolveChatHistoryLoadState({
      boundary: { kind: 'has-more', cursor: 'msg_1', loadedTurns: 6 },
      assistantComplete: true,
    })).toEqual({ complete: false, canLoadEarlier: true });
  });

  test('exhausted live boundary with no assistant archive is fully complete', () => {
    expect(resolveChatHistoryLoadState({
      boundary: { kind: 'exhausted', loadedTurns: 20 },
      assistantComplete: true,
    })).toEqual({ complete: true, canLoadEarlier: false });
  });

  test('live exhausted with incomplete assistant archive can still load archive pages', () => {
    expect(resolveChatHistoryLoadState({
      boundary: { kind: 'exhausted', loadedTurns: 20 },
      assistantComplete: false,
    })).toEqual({ complete: false, canLoadEarlier: true });
  });

  test('unknown boundary never gains load-more from an incomplete assistant archive', () => {
    // The archive may only page after live pagination is positively exhausted.
    expect(resolveChatHistoryLoadState({
      boundary: { kind: 'unknown', loadedTurns: 0 },
      assistantComplete: false,
    })).toEqual({ complete: false, canLoadEarlier: false });
  });
});

describe('resolveChatHistoryPaginationLoading', () => {
  test('idle sync + idle assistant is not loading', () => {
    expect(resolveChatHistoryPaginationLoading({
      syncLoading: false,
      assistantLoading: false,
    })).toBe(false);
  });

  test('real useSync pagination flight blocks concurrent load-more', () => {
    expect(resolveChatHistoryPaginationLoading({
      syncLoading: true,
      assistantLoading: false,
    })).toBe(true);
  });

  test('assistant archive page flight blocks concurrent load-more', () => {
    expect(resolveChatHistoryPaginationLoading({
      syncLoading: false,
      assistantLoading: true,
    })).toBe(true);
  });

  test('background sessionPrefetch loading alone never blocks user load-more', () => {
    // Regression (Android WebView): stuck prefetch status==='loading' used to
    // OR into historyMeta.loading, so mobile "load older" waited out the
    // historyLoading window then toasted with zero sync.loadMore. Prefetch
    // stays on the transcript gate.
    const prefetchStatus: 'loading' | 'ready' | 'error' = 'loading';
    const historyLoading = resolveChatHistoryPaginationLoading({
      syncLoading: false,
      assistantLoading: false,
    });
    // Prefetch must not participate — only the pure inputs above matter.
    expect(prefetchStatus).toBe('loading');
    expect(historyLoading).toBe(false);
  });
});

describe('resolveDesktopLoadOlderStatusVisibility', () => {
  test('desktop shows restrained status only while loadOlder is in flight', () => {
    expect(resolveDesktopLoadOlderStatusVisibility({
      isMobile: false,
      isLoadingOlder: true,
    })).toBe(true);
    expect(resolveDesktopLoadOlderStatusVisibility({
      isMobile: false,
      isLoadingOlder: false,
    })).toBe(false);
  });

  test('mobile never uses the desktop status line (button owns feedback)', () => {
    expect(resolveDesktopLoadOlderStatusVisibility({
      isMobile: true,
      isLoadingOlder: true,
    })).toBe(false);
  });
});

describe('boundary-driven history entry', () => {
  const visible = (boundary: Parameters<typeof resolveChatHistoryLoadState>[0]['boundary']) => {
    const loadState = resolveChatHistoryLoadState({ boundary, assistantComplete: true });
    return resolveMobileLoadOlderVisibility({
      isMobile: true,
      canLoadEarlier: loadState.canLoadEarlier,
      isLoadingOlder: false,
    });
  };

  test('boundary-only unknown → has-more update opens the history entry', () => {
    expect(visible({ kind: 'unknown', loadedTurns: 0 })).toBe(false);
    expect(visible({ kind: 'has-more', cursor: 'msg_1', loadedTurns: 6 })).toBe(true);
  });

  test('boundary-only unknown → exhausted update keeps the entry hidden', () => {
    expect(visible({ kind: 'unknown', loadedTurns: 0 })).toBe(false);
    expect(visible({ kind: 'exhausted', loadedTurns: 2 })).toBe(false);
  });

  test('cached has-more boundary re-entry shows the entry immediately', () => {
    // Re-entering a session whose child-store boundary is already known must
    // not wait for any prefetch/SWR flight.
    expect(visible({ kind: 'has-more', cursor: 'msg_9', loadedTurns: 12 })).toBe(true);
  });

  test('cached exhausted boundary re-entry hides the entry immediately', () => {
    expect(visible({ kind: 'exhausted', loadedTurns: 12 })).toBe(false);
  });

  test('assistant archive stays loadable after live exhausted', () => {
    const loadState = resolveChatHistoryLoadState({
      boundary: { kind: 'exhausted', loadedTurns: 12 },
      assistantComplete: false,
    });
    expect(loadState).toEqual({ complete: false, canLoadEarlier: true });
    expect(resolveMobileLoadOlderVisibility({
      isMobile: true,
      canLoadEarlier: loadState.canLoadEarlier,
      isLoadingOlder: false,
    })).toBe(true);
  });

  test('prefetch request status never contributes entry facts', () => {
    // loading/ready are lifecycle only: an unknown boundary stays hidden
    // regardless, and a has-more boundary stays visible regardless.
    expect(visible({ kind: 'unknown', loadedTurns: 0 })).toBe(false);
    expect(visible({ kind: 'has-more', cursor: 'msg_1', loadedTurns: 6 })).toBe(true);
  });
});

describe('mobile load-older affordance', () => {
  test('unknown boundary hides the button', () => {
    const loadState = resolveChatHistoryLoadState({
      boundary: { kind: 'unknown', loadedTurns: 0 },
      assistantComplete: true,
    });
    expect(loadState).toEqual({ complete: false, canLoadEarlier: false });
    expect(resolveMobileLoadOlderVisibility({
      isMobile: true,
      canLoadEarlier: loadState.canLoadEarlier,
      isLoadingOlder: false,
    })).toBe(false);
  });

  test('has-more boundary paints an enabled (non-busy) button', () => {
    const loadState = resolveChatHistoryLoadState({
      boundary: { kind: 'has-more', cursor: 'msg_1', loadedTurns: 6 },
      assistantComplete: true,
    });
    expect(loadState.canLoadEarlier).toBe(true);
    expect(resolveMobileLoadOlderVisibility({
      isMobile: true,
      canLoadEarlier: loadState.canLoadEarlier,
      isLoadingOlder: false,
    })).toBe(true);
    expect(resolveMobileLoadOlderBusy({ isLoadingOlder: false })).toBe(false);
  });

  test('exhausted boundary hides the button', () => {
    const loadState = resolveChatHistoryLoadState({
      boundary: { kind: 'exhausted', loadedTurns: 12 },
      assistantComplete: true,
    });
    expect(loadState).toEqual({ complete: true, canLoadEarlier: false });
    expect(resolveMobileLoadOlderVisibility({
      isMobile: true,
      canLoadEarlier: loadState.canLoadEarlier,
      isLoadingOlder: false,
    })).toBe(false);
  });

  test('a user-initiated loadEarlier mutation keeps the button painted and busy', () => {
    // During the mutation the boundary may still read unknown; the flight
    // itself must keep the button visible so its spinner has an anchor.
    expect(resolveMobileLoadOlderVisibility({
      isMobile: true,
      canLoadEarlier: false,
      isLoadingOlder: true,
    })).toBe(true);
    expect(resolveMobileLoadOlderBusy({ isLoadingOlder: true })).toBe(true);
  });

  test('background prefetch/SWR loading never paints or busies the button', () => {
    // Unknown boundary + background flight only: no placeholder, no spinner.
    expect(resolveMobileLoadOlderVisibility({
      isMobile: true,
      canLoadEarlier: false,
      isLoadingOlder: false,
    })).toBe(false);
    expect(resolveMobileLoadOlderBusy({ isLoadingOlder: false })).toBe(false);
  });

  test('desktop never paints the mobile button', () => {
    expect(resolveMobileLoadOlderVisibility({
      isMobile: false,
      canLoadEarlier: true,
      isLoadingOlder: false,
    })).toBe(false);
    expect(resolveMobileLoadOlderVisibility({
      isMobile: false,
      canLoadEarlier: false,
      isLoadingOlder: true,
    })).toBe(false);
  });
});

describe('hasChatTranscriptShell', () => {
  test('any landed transcript row is a shell, including assistant-only', () => {
    expect(hasChatTranscriptShell({
      transcriptMessageCount: 1,
      pendingUserCount: 0,
      historyPrefixCount: 0,
    })).toBe(true);
  });

  test('an empty transcript is not a shell', () => {
    expect(hasChatTranscriptShell({
      transcriptMessageCount: 0,
      pendingUserCount: 0,
      historyPrefixCount: 0,
    })).toBe(false);
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

  test('user retry leaves the load-error wall for the skeleton', () => {
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: false,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'error',
      syncLoading: false,
      userRetrying: true,
    })).toBe('hydrating');
  });

  test('passes as soon as durable or authority hydration satisfies P0', () => {
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: true,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'loading',
      syncLoading: false,
      p0Satisfied: true,
    })).toBe('pass');

    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: true,
      hasRenderableSessionSnapshot: true,
      prefetchStatus: 'ready',
      syncLoading: false,
      p0Satisfied: true,
    })).toBe('pass');
  });

  test('keeps a live user-tail shell visible while the session is busy', () => {
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: true,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'loading',
      syncLoading: true,
      p0Satisfied: false,
      hasBusyShell: true,
    })).toBe('pass');
  });

  test('landed rows stay visible while a refetch is in flight, even before P0', () => {
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: true,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'loading',
      syncLoading: true,
      p0Satisfied: false,
    })).toBe('pass');
  });

  test('keeps the original safe gate for an ordinary empty session', () => {
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: false,
      hasRenderableSessionSnapshot: true,
      prefetchStatus: 'ready',
      syncLoading: false,
      p0Satisfied: false,
    })).toBe('pass');
  });

  test('a painted transcript is never demoted to the skeleton by a transient empty read', () => {
    // Cache eviction / transport swap: the shell is momentarily gone and the
    // refetch is in flight. Demoting here unmounts the viewport and composer.
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: false,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'loading',
      syncLoading: true,
      hasPaintedTranscript: true,
    })).toBe('pass');

    // Same read without the retention still hydrates — the stickiness must be
    // what carries it, not a loosened loading branch.
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: false,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'loading',
      syncLoading: true,
      hasPaintedTranscript: false,
    })).toBe('hydrating');
  });

  test('a painted transcript outranks a settled refetch failure', () => {
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: false,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'error',
      syncLoading: false,
      hasPaintedTranscript: true,
    })).toBe('pass');
  });

  test('a latched P0 result remains visible through a later fetch failure when rows still exist', () => {
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: true,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'error',
      syncLoading: false,
      p0Satisfied: true,
    })).toBe('pass');
  });

  test('a P0 latch without rows does not invent the empty-chat welcome', () => {
    // Session-view remount after Query GC: latch survived, rows did not.
    // Passing here flashes "Start a new chat" until the tail returns.
    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: false,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'ready',
      syncLoading: false,
      p0Satisfied: true,
    })).toBe('hydrating');

    expect(resolveChatSessionTranscriptGate({
      hasTranscriptShell: false,
      hasRenderableSessionSnapshot: false,
      prefetchStatus: 'error',
      syncLoading: false,
      p0Satisfied: true,
    })).toBe('load-error');
  });
});

describe('resolveRetainedTranscript', () => {
  const rows = (...ids: string[]) => ids.map((id) => ({ id }));

  test('a non-empty read wins and becomes the retention', () => {
    const next = rows('m1', 'm2');
    const result = resolveRetainedTranscript({
      sessionId: 'ses_1',
      messages: next,
      retained: { sessionId: 'ses_1', messages: rows('stale') },
    });

    expect(result.messages).toBe(next);
    expect(result.retained).toEqual({ sessionId: 'ses_1', messages: next });
  });

  test('an empty read replays the retained rows for the same session', () => {
    const painted = rows('m1', 'm2');
    const result = resolveRetainedTranscript({
      sessionId: 'ses_1',
      messages: [],
      retained: { sessionId: 'ses_1', messages: painted },
    });

    // Count stays stable across the empty read, so the timeline does not read
    // the rebound as "first content landed" and re-pin to the bottom.
    expect(result.messages).toBe(painted);
    expect(result.messages).toHaveLength(2);
  });

  test('retention never leaks across a session switch', () => {
    const result = resolveRetainedTranscript({
      sessionId: 'ses_2',
      messages: [],
      retained: { sessionId: 'ses_1', messages: rows('other-session') },
    });

    expect(result.messages).toEqual([]);
    expect(result.retained).toBeNull();
  });

  test('drops retention when there is no session', () => {
    const result = resolveRetainedTranscript({
      sessionId: null,
      messages: [],
      retained: { sessionId: 'ses_1', messages: rows('m1') },
    });

    expect(result.retained).toBeNull();
  });
});
