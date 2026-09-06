/**
 * List scroll / update cadence harness for Lynx chat.
 *
 * Cap reference (NOT Lynx device numbers — do not claim as 真机):
 * - `streamingRenderCadence.ts`: iOS/default textThrottleMs=20, markdownPaceMs=64
 * - Android: textThrottleMs=100, markdownPaceMs=128
 *
 * This harness measures synthetic update intervals in unit tests so a later
 * device run can compare against Cap notes without inventing p95 budgets.
 */
import {
  appendLiveEntries,
  applyInitialPage,
  applyOlderPage,
  beginLoadOlder,
  clearPrependSettle,
  createEmptyTimelineState,
  type LynxTimelineEntry,
  type LynxTimelineState,
} from '../chat/timelineModel';
import {
  resolveLynxTimelineListFlags,
  type LynxTimelineListFlags,
} from '../chat/listSemantics';

/** Cap `resolveStreamingRenderCadence` values — documentation anchors only. */
export const CAP_STREAMING_RENDER_CADENCE = {
  default: { textThrottleMs: 20, markdownPaceMs: 64 },
  android: { textThrottleMs: 100, markdownPaceMs: 128 },
} as const;

export type LynxListPerfPlatform = 'ios' | 'android' | 'default';

export function resolveLynxStreamingCadenceNotes(
  platform: LynxListPerfPlatform,
): { textThrottleMs: number; markdownPaceMs: number; source: string } {
  if (platform === 'android') {
    return {
      ...CAP_STREAMING_RENDER_CADENCE.android,
      source: 'Cap streamingRenderCadence.ts (android)',
    };
  }
  return {
    ...CAP_STREAMING_RENDER_CADENCE.default,
    source: 'Cap streamingRenderCadence.ts (default/ios)',
  };
}

export type LynxListUpdateSample = {
  index: number;
  /** Synthetic clock ms when the update was applied. */
  atMs: number;
  /** Delta from previous sample (undefined for first). */
  deltaMs?: number;
  entryCount: number;
  flags: LynxTimelineListFlags;
};

export type LynxListPerfHarnessResult = {
  samples: LynxListUpdateSample[];
  /** Mean inter-update interval for streaming appends (excludes first). */
  meanStreamingDeltaMs: number | null;
  /** Max inter-update interval. */
  maxStreamingDeltaMs: number | null;
  prependKeptAnchor: boolean;
  followWhileStreaming: boolean;
  capCadenceNotes: ReturnType<typeof resolveLynxStreamingCadenceNotes>;
  /** Explicit: these are harness math, not device measurements. */
  deviceMeasured: false;
};

const makeEntry = (id: string, text: string): LynxTimelineEntry => ({
  key: id,
  messageId: id,
  role: 'assistant',
  text,
  createdAt: 0,
  parts: [{ type: 'text', id: `${id}_t`, text }],
});

/**
 * Drive N streaming appends on a synthetic clock and record cadence.
 * Also exercises prepend settle so maintainVisibleContentPosition spirit is checked.
 */
export function runLynxListPerfHarness(input?: {
  streamUpdates?: number;
  /** Synthetic ms between stream updates (test clock, not device). */
  streamIntervalMs?: number;
  platform?: LynxListPerfPlatform;
}): LynxListPerfHarnessResult {
  const streamUpdates = input?.streamUpdates ?? 8;
  const streamIntervalMs = input?.streamIntervalMs ?? 20;
  const platform = input?.platform ?? 'default';
  const capCadenceNotes = resolveLynxStreamingCadenceNotes(platform);

  let state: LynxTimelineState = createEmptyTimelineState('ses_perf');
  state = applyInitialPage(state, {
    entries: [makeEntry('msg_seed', 'seed')],
    olderCursor: 'msg_old',
    canLoadEarlier: true,
  });
  state = { ...state, sessionIsWorking: true, followEnabled: true, endSettledOnce: true };

  const samples: LynxListUpdateSample[] = [];
  let clock = 0;

  const record = () => {
    const flags = resolveLynxTimelineListFlags({
      followEnabled: state.followEnabled,
      historyAnchorActive: state.historyAnchorKeys !== null,
      sessionIsWorking: state.sessionIsWorking,
      endSettledOnce: state.endSettledOnce,
      prependSettling: state.prependSettling,
      knownKeys: state.historyAnchorKeys ?? undefined,
    });
    const prev = samples.at(-1);
    samples.push({
      index: samples.length,
      atMs: clock,
      deltaMs: prev ? clock - prev.atMs : undefined,
      entryCount: state.entries.length,
      flags,
    });
  };

  record();

  for (let i = 0; i < streamUpdates; i += 1) {
    clock += streamIntervalMs;
    const id = `msg_live_${i}`;
    state = appendLiveEntries(state, [makeEntry(id, `token-${i}`)]);
    record();
  }

  const followWhileStreaming = samples
    .slice(1)
    .every((sample) => sample.flags.maintainScrollAtEnd !== false);

  // Prepend older page — anchor keys must survive until clearPrependSettle.
  const anchorBefore = state.entries[0]?.key ?? null;
  state = beginLoadOlder(state);
  const anchorKeys = state.historyAnchorKeys;
  clock += 5;
  state = applyOlderPage(state, {
    entries: [makeEntry('msg_older', 'older')],
    olderCursor: null,
    canLoadEarlier: false,
  });
  const prependKeptAnchor = Boolean(
    anchorKeys?.has(anchorBefore!)
    && state.entries.some((entry) => entry.key === anchorBefore),
  );
  state = clearPrependSettle(state);

  const deltas = samples
    .map((sample) => sample.deltaMs)
    .filter((value): value is number => typeof value === 'number');
  const meanStreamingDeltaMs = deltas.length > 0
    ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
    : null;
  const maxStreamingDeltaMs = deltas.length > 0 ? Math.max(...deltas) : null;

  return {
    samples,
    meanStreamingDeltaMs,
    maxStreamingDeltaMs,
    prependKeptAnchor,
    followWhileStreaming,
    capCadenceNotes,
    deviceMeasured: false,
  };
}

/**
 * Assert harness cadence matches the *configured* Cap interval when the test
 * clock uses that interval — not a claim about real devices.
 */
export function assertHarnessCadenceMatchesCapNotes(
  result: LynxListPerfHarnessResult,
  expectedIntervalMs: number,
): void {
  if (result.deviceMeasured) {
    throw new Error('harness result unexpectedly marked deviceMeasured');
  }
  if (result.meanStreamingDeltaMs !== expectedIntervalMs) {
    throw new Error(
      `expected mean delta ${expectedIntervalMs}ms (test clock), got ${result.meanStreamingDeltaMs}`,
    );
  }
  if (!result.prependKeptAnchor) {
    throw new Error('prepend did not keep history anchor');
  }
}
