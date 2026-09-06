/**
 * Pure timeline model: one list owns history + live tail.
 * Prepend older pages without inventing a second scroller / split list.
 */

export type LynxTimelineRole = 'user' | 'assistant' | 'system' | 'unknown';

export type LynxTimelineEntry = {
  key: string;
  messageId: string;
  role: LynxTimelineRole;
  text: string;
  createdAt?: number;
};

export type LynxTimelinePage = {
  entries: LynxTimelineEntry[];
  /** Cursor for the next older page; null when the authoritative boundary says no more. */
  olderCursor: string | null;
  canLoadEarlier: boolean;
};

export type LynxTimelineState = {
  sessionId: string;
  directory: string | null;
  entries: LynxTimelineEntry[];
  olderCursor: string | null;
  canLoadEarlier: boolean;
  isLoadingOlder: boolean;
  loadOlderError: string | null;
  followEnabled: boolean;
  historyAnchorKeys: ReadonlySet<string> | null;
  prependSettling: boolean;
  sessionIsWorking: boolean;
  endSettledOnce: boolean;
  /** Settled fetch failure for the initial tail — never painted as empty success. */
  initialError: string | null;
  hydrated: boolean;
};

export const createEmptyTimelineState = (
  sessionId: string,
  directory: string | null = null,
): LynxTimelineState => ({
  sessionId,
  directory,
  entries: [],
  olderCursor: null,
  canLoadEarlier: false,
  isLoadingOlder: false,
  loadOlderError: null,
  followEnabled: true,
  historyAnchorKeys: null,
  prependSettling: false,
  sessionIsWorking: false,
  endSettledOnce: false,
  initialError: null,
  hydrated: false,
});

export function applyInitialPage(
  state: LynxTimelineState,
  page: LynxTimelinePage,
): LynxTimelineState {
  return {
    ...state,
    entries: page.entries,
    olderCursor: page.olderCursor,
    canLoadEarlier: page.canLoadEarlier,
    initialError: null,
    hydrated: true,
    endSettledOnce: page.entries.length > 0,
    followEnabled: true,
    historyAnchorKeys: null,
    prependSettling: false,
  };
}

export function applyInitialFailure(
  state: LynxTimelineState,
  error: string,
): LynxTimelineState {
  return {
    ...state,
    initialError: error,
    hydrated: true,
    // Keep entries if any; never convert failure into empty success.
    canLoadEarlier: state.canLoadEarlier,
  };
}

export function beginLoadOlder(state: LynxTimelineState): LynxTimelineState {
  if (!state.canLoadEarlier || state.isLoadingOlder) return state;
  return {
    ...state,
    isLoadingOlder: true,
    loadOlderError: null,
    historyAnchorKeys: new Set(state.entries.map((entry) => entry.key)),
    prependSettling: true,
    followEnabled: false,
  };
}

export function applyOlderPage(
  state: LynxTimelineState,
  page: LynxTimelinePage,
): LynxTimelineState {
  if (!state.isLoadingOlder) return state;
  const existingKeys = new Set(state.entries.map((entry) => entry.key));
  const prepended = page.entries.filter((entry) => !existingKeys.has(entry.key));
  return {
    ...state,
    entries: [...prepended, ...state.entries],
    olderCursor: page.olderCursor,
    canLoadEarlier: page.canLoadEarlier,
    isLoadingOlder: false,
    loadOlderError: null,
    // Keep anchor until caller clears settle; follow stays off during settle.
    prependSettling: true,
  };
}

export function failLoadOlder(
  state: LynxTimelineState,
  error: string,
): LynxTimelineState {
  if (!state.isLoadingOlder) return state;
  return {
    ...state,
    isLoadingOlder: false,
    loadOlderError: error,
    historyAnchorKeys: null,
    prependSettling: false,
    followEnabled: true,
  };
}

export function clearPrependSettle(state: LynxTimelineState): LynxTimelineState {
  if (!state.prependSettling && !state.historyAnchorKeys) return state;
  return {
    ...state,
    historyAnchorKeys: null,
    prependSettling: false,
    followEnabled: true,
  };
}

export function appendLiveEntries(
  state: LynxTimelineState,
  entries: readonly LynxTimelineEntry[],
): LynxTimelineState {
  if (entries.length === 0) return state;
  const existingKeys = new Set(state.entries.map((entry) => entry.key));
  const next = entries.filter((entry) => !existingKeys.has(entry.key));
  if (next.length === 0) {
    // Allow in-place text updates for streaming same-key rows.
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    return {
      ...state,
      entries: state.entries.map((entry) => byKey.get(entry.key) ?? entry),
      endSettledOnce: true,
    };
  }
  return {
    ...state,
    entries: [...state.entries, ...next],
    endSettledOnce: true,
  };
}

export function setSessionWorking(
  state: LynxTimelineState,
  working: boolean,
): LynxTimelineState {
  return { ...state, sessionIsWorking: working };
}

export function setFollowEnabled(
  state: LynxTimelineState,
  followEnabled: boolean,
): LynxTimelineState {
  return { ...state, followEnabled };
}
