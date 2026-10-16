/** Classify execution boundaries, not individual tool/assistant-step completion. */
export function completionEvent(payload) {
  if (typeof payload?.type !== 'string') return null;
  const type = payload.type.replace(/\.\d+$/, '');
  const body = payload?.properties ?? payload?.data ?? {};
  const info = body.info;
  const sessionId = body.sessionID ?? body.sessionId ?? info?.sessionID;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  if (type === 'session.execution.started' || type === 'session.step.started' || type === 'session.retry.scheduled'
    || (type === 'session.status' && (body.status?.type === 'busy' || body.status?.type === 'retry'))) {
    return { kind: 'running', sessionId };
  }
  if (type === 'session.execution.succeeded' || type === 'session.idle'
    || (type === 'message.updated' && info?.role === 'assistant' && info.finish === 'stop')) {
    return { kind: 'complete', sessionId };
  }
  if (type === 'session.execution.failed' || type === 'session.error' || type === 'session.deleted'
    || (type === 'message.updated' && info?.role === 'assistant' && info.finish === 'error')) {
    return { kind: 'cancel', sessionId };
  }
  if (type === 'session.execution.interrupted') {
    return { kind: body.reason === 'shutdown' ? 'running' : 'cancel', sessionId };
  }
  if (type === 'session.status') return { kind: 'changed', sessionId };
  return null;
}

/** Runtime-local completion barrier shared by Host fanout and VS Code. */
export function createFamilyCompletionGate({ loadActiveSessionIds, loadParent, onReady, retryMs = 2000 }) {
  const pending = new Map();
  const delivered = new Set();
  const running = new Set();
  let revision = 0;
  let epoch = 0;
  let disposed = false;
  let flight;
  let timer;
  let rerun = false;

  const schedule = () => {
    if (disposed || timer || !pending.size) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, retryMs);
    timer.unref?.();
  };

  const check = async () => {
    const version = revision;
    const generation = epoch;
    const current = () => !disposed && epoch === generation && revision === version;
    const membership = await loadActiveSessionIds();
    if (!membership || typeof membership[Symbol.iterator] !== 'function') throw new Error('Unknown session activity');
    const active = new Set(membership);
    if (!current()) return;
    const parents = new Map();
    const parentOf = (id) => {
      if (!parents.has(id)) parents.set(id, Promise.resolve().then(() => loadParent(id)).then((parent) => {
        if (parent !== null && (typeof parent !== 'string' || !parent)) throw new Error('Unknown session ancestry');
        return parent;
      }));
      return parents.get(id);
    };
    // A running ID can belong to any pending root, including through idle ancestors.
    const activeRoots = new Set();
    const ids = [...active];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length) {
        let id = ids[cursor++];
        const seen = new Set();
        while (id) {
          if (seen.has(id)) throw new Error('Cyclic session ancestry');
          seen.add(id);
          activeRoots.add(id);
          id = await parentOf(id);
        }
      }
    }));
    for (const [id, candidate] of pending) {
      if (!current()) return;
      const parent = await parentOf(id);
      if (!current() || pending.get(id) !== candidate) continue;
      if (parent) { pending.delete(id); continue; }
      if (activeRoots.has(id)) continue;
      const isCurrent = () => current() && pending.get(id) === candidate;
      const handled = await onReady(candidate.payload, isCurrent);
      // onReady fences before dispatch. Events during a committed asynchronous
      // fanout must not make that same completion eligible a second time.
      if (handled === false || pending.get(id) !== candidate) continue;
      pending.delete(id);
      delivered.add(id);
      running.delete(id);
    }
  };

  const drain = () => {
    if (disposed || !pending.size) {
      clearTimeout(timer);
      timer = undefined;
      return Promise.resolve();
    }
    if (flight) { rerun = true; return flight; }
    const generation = epoch;
    flight = (async () => {
      do {
        rerun = false;
        try { await check(); } catch {
          // Unknown authority is not empty success. Retain candidates for retry.
        }
      } while (rerun && !disposed && generation === epoch && pending.size);
    })().finally(() => {
      flight = undefined;
      if (!pending.size) {
        clearTimeout(timer);
        timer = undefined;
      }
      schedule();
    });
    return flight;
  };

  return {
    observe(event, payload) {
      if (disposed || !event) return Promise.resolve();
      revision += 1;
      const { sessionId, kind } = event;
      if (kind === 'running') {
        if (!running.has(sessionId)) {
          delivered.delete(sessionId);
          pending.delete(sessionId);
        }
        running.add(sessionId);
      } else if (kind === 'cancel') {
        running.delete(sessionId);
        pending.delete(sessionId);
        delivered.add(sessionId);
      } else if (kind === 'complete') {
        running.delete(sessionId);
        if (!delivered.has(sessionId)) {
          const candidate = pending.get(sessionId);
          if (candidate) candidate.payload = payload;
          else pending.set(sessionId, { payload });
        }
      }
      return drain();
    },
    reset() {
      epoch += 1;
      revision += 1;
      pending.clear();
      delivered.clear();
      running.clear();
      clearTimeout(timer);
      timer = undefined;
    },
    dispose() {
      this.reset();
      disposed = true;
    },
  };
}
