import { describe, expect, test } from 'vitest';

import {
  applyInitialFailure,
  applyInitialPage,
  applyOlderPage,
  beginLoadOlder,
  clearPrependSettle,
  createEmptyTimelineState,
  failLoadOlder,
  appendLiveEntries,
} from './timelineModel';

const entry = (id: string, text = id) => ({
  key: id,
  messageId: id,
  role: 'user' as const,
  text,
});

describe('Lynx timeline model', () => {
  test('applies initial page at live edge without empty-success on failure', () => {
    const empty = createEmptyTimelineState('ses_1', '/repo');
    const ok = applyInitialPage(empty, {
      entries: [entry('a'), entry('b')],
      olderCursor: 'a',
      canLoadEarlier: true,
    });
    expect(ok.entries.map((e) => e.key)).toEqual(['a', 'b']);
    expect(ok.hydrated).toBe(true);
    expect(ok.followEnabled).toBe(true);

    const failed = applyInitialFailure(empty, 'boom');
    expect(failed.initialError).toBe('boom');
    expect(failed.entries).toEqual([]);
    expect(failed.hydrated).toBe(true);
  });

  test('load-older prepends under a history anchor then settles', () => {
    let state = applyInitialPage(createEmptyTimelineState('ses_1'), {
      entries: [entry('b'), entry('c')],
      olderCursor: 'b',
      canLoadEarlier: true,
    });
    state = beginLoadOlder(state);
    expect(state.isLoadingOlder).toBe(true);
    expect(state.followEnabled).toBe(false);
    expect(state.historyAnchorKeys?.has('b')).toBe(true);

    state = applyOlderPage(state, {
      entries: [entry('a'), entry('b')],
      olderCursor: 'a',
      canLoadEarlier: true,
    });
    expect(state.entries.map((e) => e.key)).toEqual(['a', 'b', 'c']);
    expect(state.isLoadingOlder).toBe(false);

    state = clearPrependSettle(state);
    expect(state.historyAnchorKeys).toBeNull();
    expect(state.followEnabled).toBe(true);
  });

  test('failed load-older keeps existing rows and surfaces error', () => {
    let state = applyInitialPage(createEmptyTimelineState('ses_1'), {
      entries: [entry('b')],
      olderCursor: 'b',
      canLoadEarlier: true,
    });
    state = beginLoadOlder(state);
    state = failLoadOlder(state, 'timeout');
    expect(state.entries).toHaveLength(1);
    expect(state.loadOlderError).toBe('timeout');
    expect(state.followEnabled).toBe(true);
  });

  test('appendLiveEntries updates streaming same-key rows', () => {
    let state = applyInitialPage(createEmptyTimelineState('ses_1'), {
      entries: [entry('a', 'hi')],
      olderCursor: null,
      canLoadEarlier: false,
    });
    state = appendLiveEntries(state, [entry('a', 'hi there')]);
    expect(state.entries[0]?.text).toBe('hi there');
    state = appendLiveEntries(state, [entry('b', 'new')]);
    expect(state.entries.map((e) => e.key)).toEqual(['a', 'b']);
  });
});
