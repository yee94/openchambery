// Periodic Live Activity snapshot refresh for iOS devices that registered a
// Live Activity push token. While the app is foreground/connected the UI keeps
// its own ActivityKit state fresh; once iOS suspends or kills the app, only
// APNs can move the on-screen activity. Completion/error/title already push
// event-driven (runtime.js → sendLiveActivityEnd); this runtime covers the
// busy phase: every interval it recomputes each persisted token's snapshot
// from the authoritative session-status snapshot and pushes an update only
// when something actually changed (APNs budgets Live Activity updates per
// hour, so unchanged snapshots never send).
//
// Interval: default 30s, override with OPENCHAMBER_LIVE_ACTIVITY_REFRESH_INTERVAL_MS
// (milliseconds; `0` disables the timer). Snapshots use unix seconds, matching
// the persisted token store (apns-runtime.js parseLiveActivitySnapshot).

export const LIVE_ACTIVITY_REFRESH_DEFAULT_INTERVAL_MS = 30_000;
export const LIVE_ACTIVITY_REFRESH_ITEM_LIMIT = 4; // mirrors the UI catalog cap
export const LIVE_ACTIVITY_REFRESH_TITLE_MAX = 80;

export const resolveLiveActivityRefreshIntervalMs = (env = process.env) => {
  const raw = env?.OPENCHAMBER_LIVE_ACTIVITY_REFRESH_INTERVAL_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return LIVE_ACTIVITY_REFRESH_DEFAULT_INTERVAL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return LIVE_ACTIVITY_REFRESH_DEFAULT_INTERVAL_MS;
  return Math.floor(parsed);
};

const liveActivityItemIsWorking = (status) => status !== 'complete' && status !== 'error';

// Session-side sub-states the server has no authoritative source for. The UI
// derives them from live permission/question/message-delta channels; once it is
// gone we keep the last row state instead of flickering back to `working`.
const LIVE_ACTIVITY_PRESERVED_ROW_STATUSES = new Set(['permission', 'input', 'tool']);

const mapSessionStatusToRowStatus = (sessionStatus) => {
  if (sessionStatus === 'retry') return 'retry';
  if (sessionStatus === 'busy') return 'working';
  return null; // idle / unknown → terminal
};

const nextRowStatus = (currentRowStatus, sessionStatus) => {
  if (sessionStatus === 'busy') {
    if (LIVE_ACTIVITY_PRESERVED_ROW_STATUSES.has(currentRowStatus)) return currentRowStatus;
    return 'working'; // including stale → working (server connection is authoritative here)
  }
  if (sessionStatus === 'retry') return 'retry';
  return 'complete';
};

const capLiveActivityItems = (items) => {
  if (items.length <= LIVE_ACTIVITY_REFRESH_ITEM_LIMIT) return items;
  const working = items.filter((item) => liveActivityItemIsWorking(item.status));
  const settled = items
    .filter((item) => !liveActivityItemIsWorking(item.status))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const next = [...working];
  for (const item of settled) {
    if (next.length >= LIVE_ACTIVITY_REFRESH_ITEM_LIMIT) break;
    next.push(item);
  }
  return next.slice(0, LIVE_ACTIVITY_REFRESH_ITEM_LIMIT);
};

const liveActivityItemsSignature = (items) => items
  .map((item) => `${item.sessionId}\0${item.title}\0${item.status}\0${item.endedAt ?? ''}`)
  .join('\n');

/**
 * Recompute one entry's snapshot from the authoritative session-state snapshot.
 * Returns `{ items }` (unix seconds) when something changed, `null` to skip.
 * Rows for sessions with no live server state are preserved as-is (never guess
 * terminal from missing data); new busy/retry sessions join only when the
 * injected resolver confirms sidebar visibility.
 */
export const computeLiveActivityRefreshSnapshot = async (input) => {
  const { entry, sessionStates, resolveSession, nowMs } = input;
  const nowSeconds = Math.floor(nowMs / 1000);
  const previous = Array.isArray(entry.snapshot) ? entry.snapshot : [];
  const items = [];
  const seen = new Set();

  for (const item of previous) {
    if (!item || typeof item.sessionId !== 'string') continue;
    seen.add(item.sessionId);
    const state = sessionStates[item.sessionId];
    if (!state) {
      items.push(item); // no authoritative state → keep the last known row
      continue;
    }
    const rowStatus = nextRowStatus(item.status, state.status);
    if (rowStatus === item.status) {
      items.push(item);
      continue;
    }
    if (rowStatus === 'complete') {
      items.push({
        ...item,
        status: 'complete',
        endedAt: item.endedAt ?? nowSeconds,
      });
      continue;
    }
    items.push({ ...item, status: rowStatus });
  }

  const additions = [];
  for (const [sessionId, state] of Object.entries(sessionStates || {})) {
    if (seen.has(sessionId)) continue;
    const mapped = mapSessionStatusToRowStatus(state?.status);
    if (mapped === null || mapped === 'complete') continue;
    let candidate = null;
    try {
      candidate = await resolveSession(sessionId);
    } catch {
      candidate = null;
    }
    if (!candidate || candidate.visible !== true) continue;
    additions.push({
      sessionId,
      title: typeof candidate.title === 'string' ? candidate.title.slice(0, LIVE_ACTIVITY_REFRESH_TITLE_MAX) : '',
      status: mapped,
      startedAt: nowSeconds,
    });
  }

  const merged = capLiveActivityItems([...items, ...additions]);
  if (liveActivityItemsSignature(merged) === liveActivityItemsSignature(previous)) return null;
  return { items: merged };
};

/**
 * Owns the refresh interval. One tick snapshots the authoritative session
 * states once, then hands every persisted Live Activity entry to
 * `refreshLiveActivityTokens` (apns-runtime.js), which skips entries whose
 * computed snapshot is unchanged. Overlapping ticks are dropped, not queued.
 */
export const createLiveActivityRefreshRuntime = (deps) => {
  const {
    intervalMs,
    refreshLiveActivityTokens,
    getSessionStateSnapshot,
    resolveSession,
  } = deps;
  let timer = null;
  let ticking = false;

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const sessionStates = getSessionStateSnapshot();
      const nowMs = Date.now();
      await refreshLiveActivityTokens({
        computeSnapshot: (entry) => computeLiveActivityRefreshSnapshot({
          entry,
          sessionStates,
          resolveSession,
          nowMs,
        }),
      });
    } catch (error) {
      console.warn('[Live Activity refresh] tick failed:', error?.message ?? error);
    } finally {
      ticking = false;
    }
  };

  const start = () => {
    if (timer || !(intervalMs > 0)) return;
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
  };

  const dispose = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, dispose, tick };
};
