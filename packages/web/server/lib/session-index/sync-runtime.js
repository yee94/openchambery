const SESSION_LIMIT = 20;
/** Max upstream list pages while skipping consecutive Host-archived rows. */
const ARCHIVE_SKIP_PAGE_BUDGET = 5;
const FULL_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6_000;
const INTERACTIVE_YIELD_MS = 1_000;
const LONG_POLL_MAX_MS = 25_000;

const normalizeDirectory = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || null;
};

const updatedAt = (session) => {
  const value = session?.time?.updated ?? session?.time?.created;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const isArchivedSession = (session) => {
  const archived = session?.time?.archived;
  return typeof archived === 'number' && Number.isFinite(archived) && archived > 0;
};

const nonEmptySystemID = (value) => typeof value === 'string' && value.length > 0;

/** Match session-index service: system sessions never consume the active-20 budget. */
const isSystemSession = (session) => {
  const openchamber = session?.metadata?.openchamber;
  if (!openchamber || typeof openchamber !== 'object') return false;
  if (openchamber.assigned?.from === 'contact') return false;
  if (nonEmptySystemID(openchamber.assistant?.assistantID)) return true;
  if (nonEmptySystemID(openchamber.scheduledTask?.taskID)) return true;
  if (nonEmptySystemID(openchamber.smallModel?.purpose)) return true;
  if (nonEmptySystemID(openchamber.llm?.purpose)) return true;
  return false;
};

const isRootActiveCandidate = (session) => {
  if (!session?.id || isArchivedSession(session)) return false;
  if (typeof session.parentID === 'string' && session.parentID) return false;
  if (session.title === 'smartfetch-secondary') return false;
  if (isSystemSession(session)) return false;
  return true;
};

/**
 * v2 list cursor may be a string/number or `{ next }`. Never String(object).
 * @returns {string | null}
 */
export const extractSessionListCursorToken = (cursor) => {
  if (cursor == null || cursor === '') return null;
  if (typeof cursor === 'string' || typeof cursor === 'number' || typeof cursor === 'bigint') {
    const token = String(cursor).trim();
    return token.length > 0 ? token : null;
  }
  if (typeof cursor === 'object' && cursor.next != null && cursor.next !== '') {
    return extractSessionListCursorToken(cursor.next);
  }
  return null;
};

const mergeIncrementalSessions = (cached, changed) => {
  const byID = new Map();
  for (const session of cached ?? []) byID.set(session.id, session);
  for (const session of changed ?? []) {
    if (!session?.id) continue;
    if (isArchivedSession(session)) byID.delete(session.id);
    else byID.set(session.id, session);
  }
  return [...byID.values()]
    .sort((left, right) => updatedAt(right) - updatedAt(left) || right.id.localeCompare(left.id))
    .slice(0, SESSION_LIMIT);
};

export const createSessionIndexSyncRuntime = ({
  sessionIndexService,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  /** Optional tip sink: ({ revision, sync }) after each revision bump. */
  onRevisionTip = null,
  /**
   * Optional Host authority projection applied to each upstream list page
   * before active-only filtering (archive / metadata). Sync — no await.
   * @type {((sessions: object[]) => object[]) | null}
   */
  projectSessions = null,
  fetchFn = globalThis.fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) => {
  if (!sessionIndexService) return null;

  let revision = 0;
  let stopped = false;
  let running = false;
  let enrichingChildFlags = false;
  let currentController = null;
  let currentWasPreempted = false;
  let interactiveUntil = 0;
  let runtimeKey = sessionIndexService.getRuntimeKey();
  const queue = [];
  const childFlagQueue = [];
  const queuedDirectories = new Set();
  const queuedChildFlagKeys = new Set();
  const completedDirectories = new Set();
  const failedDirectories = new Set();
  const waiters = new Set();
  let batchDirectories = new Set();

  const syncState = () => ({
    active: running || queue.length > 0,
    enriching: enrichingChildFlags || childFlagQueue.length > 0,
    completed: completedDirectories.size,
    total: batchDirectories.size,
    pendingDirectories: [...queuedDirectories],
    completedDirectories: [...completedDirectories],
    failedDirectories: [...failedDirectories],
  });

  const snapshot = () => ({
    revision,
    sync: syncState(),
    ...sessionIndexService.snapshot(),
  });

  const notify = () => {
    revision += 1;
    const value = snapshot();
    for (const resolve of [...waiters]) resolve(value);
    if (typeof onRevisionTip === 'function') {
      try {
        onRevisionTip({
          revision: value.revision,
          sync: {
            active: value.sync.active === true,
            enriching: value.sync.enriching === true,
          },
          occurredAt: now(),
        });
      } catch (error) {
        console.warn('[session-index] onRevisionTip failed:', error);
      }
    }
  };

  const delay = (ms, signal) => new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimer(done, ms);
    const onAbort = () => {
      clearTimer(timer);
      done();
    };
    function done() {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });

  const readDirectory = (directory) => sessionIndexService.snapshot().directories
    .find((entry) => entry.directory === directory);

  const fetchDirectory = async (task) => {
    // v2 `session.list` cursor pagination. Collect candidates across pages,
    // then re-project once before commit so a Host archive that lands mid-sync
    // cannot resurrect a row. Root/system filters run before the 20-slot budget.
    // projectSessions failure aborts the refresh and keeps prior directory rows.
    const controller = new AbortController();
    currentController = controller;
    currentWasPreempted = false;
    const timeout = setTimer(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      /** @type {object[]} raw upstream sessions collected across pages */
      const collected = [];
      let pages = 0;
      let cursorToken = null;
      let upstreamHasMore = false;
      let hitPageBudget = false;
      let lastCursorToken = null;
      let seenCursor = new Set();

      while (collected.length < SESSION_LIMIT * 3 && pages < ARCHIVE_SKIP_PAGE_BUDGET) {
        const url = new URL(buildOpenCodeUrl('/session'));
        url.searchParams.set('directory', task.directory);
        url.searchParams.set('limit', String(SESSION_LIMIT));
        if (cursorToken) {
          url.searchParams.set('cursor', cursorToken);
        }

        const response = await fetchFn(url, {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new Error(`OpenCode session list failed (${response.status})`);
          error.status = response.status;
          throw error;
        }
        const payload = await response.json();
        const sessions = Array.isArray(payload) ? payload : payload?.data;
        if (!Array.isArray(sessions)) throw new Error('Invalid OpenCode session list payload');
        pages += 1;

        for (const session of sessions) {
          if (session?.id) collected.push(session);
        }

        // v2: exhaust by cursor.next when present. A short page with next is
        // still more data (archived skips / filtered upstream). Bare arrays
        // have no cursor — length < limit means end of list.
        const isEnvelope = payload && typeof payload === 'object' && !Array.isArray(payload);
        const nextToken = isEnvelope
          ? extractSessionListCursorToken(payload.cursor)
          : null;
        const pageFull = sessions.length === SESSION_LIMIT;
        if (nextToken) lastCursorToken = nextToken;

        if (nextToken) {
          upstreamHasMore = true;
          if (seenCursor.has(nextToken)) {
            // Duplicate cursor → stop (broken upstream) rather than loop forever.
            hitPageBudget = true;
            break;
          }
          seenCursor.add(nextToken);
          if (pages >= ARCHIVE_SKIP_PAGE_BUDGET) {
            hitPageBudget = true;
            break;
          }
          cursorToken = nextToken;
          continue;
        }

        // No next token: bare-array / terminal page.
        if (!pageFull) {
          upstreamHasMore = false;
          break;
        }
        // Full page without cursor — cannot continue safely.
        upstreamHasMore = true;
        hitPageBudget = true;
        break;
      }

      // Re-project the full collected set at commit time (current Host authority).
      let projected = collected;
      if (typeof projectSessions === 'function') {
        try {
          const next = projectSessions(collected);
          if (!Array.isArray(next)) {
            throw new Error('projectSessions must return an array');
          }
          projected = next;
        } catch (error) {
          // Failure is not empty success — keep prior directory rows.
          console.warn('[session-index] projectSessions failed; keeping prior directory:', error?.message ?? error);
          throw error;
        }
      }

      // Root + system filters before filling the active-20 capacity.
      const active = [];
      for (const session of projected) {
        if (!isRootActiveCandidate(session)) continue;
        if (active.length >= SESSION_LIMIT) break;
        active.push(session);
      }

      const oldest = active[active.length - 1];
      const cursorNumber = lastCursorToken && Number.isFinite(Number(lastCursorToken))
        ? Number(lastCursorToken)
        : (updatedAt(oldest) || null);
      sessionIndexService.replaceDirectory({
        directory: task.directory,
        sessions: active,
        cursor: cursorNumber,
        hasMore: upstreamHasMore || hitPageBudget || active.length === SESSION_LIMIT,
        fullSync: true,
        now: now(),
      });
      for (const session of active) {
        if (!session?.id) continue;
        const key = `${task.runtimeKey}\n${task.directory}\n${session.id}`;
        if (queuedChildFlagKeys.has(key)) continue;
        queuedChildFlagKeys.add(key);
        childFlagQueue.push({ directory: task.directory, sessionID: session.id, runtimeKey: task.runtimeKey, key });
      }
      return 'completed';
    } catch (error) {
      if (stopped || task.runtimeKey !== runtimeKey) return 'discarded';
      if (currentWasPreempted) return 'preempted';
      throw error;
    } finally {
      clearTimer(timeout);
      if (currentController === controller) currentController = null;
      currentWasPreempted = false;
    }
  };

  const fetchChildFlag = async (task) => {
    const controller = new AbortController();
    currentController = controller;
    currentWasPreempted = false;
    const timeout = setTimer(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      // v2 protocol has no `/session/:id/children` route; child sessions are a
      // `parentID` filter on the session list (`GET /api/session`).
      const url = new URL(buildOpenCodeUrl('/session'));
      url.searchParams.set('parentID', task.sessionID);
      url.searchParams.set('directory', task.directory);
      const response = await fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`OpenCode child-session list failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      // v2 wraps list responses in `{ data, cursor }`; accept a bare array too.
      const children = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.data) ? payload.data : null);
      if (!children) throw new Error('Invalid OpenCode child-session list payload');
      sessionIndexService.replaceChildSessions(task.directory, task.sessionID, children);
      return 'completed';
    } catch (error) {
      if (stopped || task.runtimeKey !== runtimeKey) return 'discarded';
      if (currentWasPreempted) return 'preempted';
      console.warn(`[SessionIndex] Child-session check failed for ${task.sessionID}:`, error);
      // Keep the last persisted value: a failed read must not masquerade as an
      // authoritative empty child list.
      return 'failed';
    } finally {
      clearTimer(timeout);
      if (currentController === controller) currentController = null;
      currentWasPreempted = false;
    }
  };

  const runChildFlagEnrichment = async () => {
    if (running || enrichingChildFlags || stopped || childFlagQueue.length === 0) return;
    enrichingChildFlags = true;
    notify();
    try {
      // Root-summary refreshes take priority over child checks. A newly queued
      // directory preempts this low-priority pass instead of waiting behind it.
      while (!stopped && !running && queue.length === 0 && childFlagQueue.length > 0) {
        const task = childFlagQueue.shift();
        if (!task) break;
        const result = await fetchChildFlag(task);
        if (result === 'preempted') {
          childFlagQueue.unshift(task);
          await delay(Math.max(0, interactiveUntil - now()));
          continue;
        }
        queuedChildFlagKeys.delete(task.key);
        notify();
      }
    } finally {
      enrichingChildFlags = false;
      notify();
      if (!stopped) {
        if (queue.length > 0) void run();
        else if (childFlagQueue.length > 0) void runChildFlagEnrichment();
      }
    }
  };

  const run = async () => {
    if (running || enrichingChildFlags || stopped) return;
    running = true;
    notify();
    try {
      const ready = await waitForOpenCodeReady?.(15_000);
      if (ready === false) throw new Error('OpenCode did not become ready');
      while (!stopped && queue.length > 0) {
        const waitMs = Math.max(0, interactiveUntil - now());
        if (waitMs > 0) await delay(waitMs);
        if (stopped) break;
        const task = queue.shift();
        if (!task) break;
        try {
          const result = await fetchDirectory(task);
          if (result === 'preempted') {
            queue.unshift(task);
            await delay(Math.max(0, interactiveUntil - now()));
            continue;
          }
          if (result === 'discarded' || stopped) continue;
          queuedDirectories.delete(task.directory);
          completedDirectories.add(task.directory);
        } catch (error) {
          queuedDirectories.delete(task.directory);
          failedDirectories.add(task.directory);
          console.warn(`[SessionIndex] Background sync failed for ${task.directory}:`, error);
        }
        notify();
      }
    } catch (error) {
      for (const task of queue.splice(0)) {
        queuedDirectories.delete(task.directory);
        failedDirectories.add(task.directory);
      }
      console.warn('[SessionIndex] Background sync could not reach OpenCode:', error);
    } finally {
      running = false;
      if (!stopped) {
        notify();
        void runChildFlagEnrichment();
      }
    }
  };

  const enqueue = (directories) => {
    const nextRuntimeKey = sessionIndexService.getRuntimeKey();
    if (nextRuntimeKey !== runtimeKey) {
      runtimeKey = nextRuntimeKey;
      currentWasPreempted = true;
      currentController?.abort();
      queue.length = 0;
      childFlagQueue.length = 0;
      queuedDirectories.clear();
      queuedChildFlagKeys.clear();
      completedDirectories.clear();
      failedDirectories.clear();
      batchDirectories = new Set();
    }
    if (!running && queue.length === 0) {
      completedDirectories.clear();
      failedDirectories.clear();
      batchDirectories = new Set();
    }
    for (const value of directories ?? []) {
      const directory = normalizeDirectory(value);
      if (!directory || batchDirectories.has(directory)) continue;
      batchDirectories.add(directory);
      queuedDirectories.add(directory);
      queue.push({ directory, runtimeKey });
    }
    if (enrichingChildFlags && currentController) {
      currentWasPreempted = true;
      currentController.abort();
    }
    notify();
    void run();
    return snapshot();
  };

  const noteInteractiveRequest = () => {
    interactiveUntil = Math.max(interactiveUntil, now() + INTERACTIVE_YIELD_MS);
    if (currentController) {
      currentWasPreempted = true;
      currentController.abort();
    }
  };

  const publishChange = () => {
    if (stopped) return;
    notify();
  };

  const waitForChange = (since, { signal, timeoutMs = LONG_POLL_MAX_MS } = {}) => {
    if (revision > since || stopped || signal?.aborted) return Promise.resolve(snapshot());
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value = snapshot()) => {
        if (settled) return;
        settled = true;
        waiters.delete(finish);
        signal?.removeEventListener?.('abort', onAbort);
        clearTimer(timer);
        resolve(value);
      };
      const onAbort = () => finish();
      const timer = setTimer(finish, Math.min(Math.max(1, timeoutMs), LONG_POLL_MAX_MS));
      waiters.add(finish);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  };

  const stop = () => {
    stopped = true;
    currentController?.abort();
    const interruptedDirectories = [...queuedDirectories];
    queue.length = 0;
    childFlagQueue.length = 0;
    queuedDirectories.clear();
    queuedChildFlagKeys.clear();
    for (const directory of interruptedDirectories) failedDirectories.add(directory);
    notify();
  };

  return { enqueue, noteInteractiveRequest, publishChange, snapshot, waitForChange, stop };
};
