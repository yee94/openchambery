/** Host projection of accepted native inbox work, independent of viewed clients. */
export const createSessionDeliveryRuntime = ({ getRuntimeIdentity = () => '' } = {}) => {
  const sessions = new Map();
  let runtimeIdentity;
  const bindRuntime = () => {
    const current = getRuntimeIdentity();
    if (current !== runtimeIdentity) {
      sessions.clear();
      runtimeIdentity = current;
    }
  };
  const stateFor = (sessionID) => {
    bindRuntime();
    let state = sessions.get(sessionID);
    if (!state) {
      if (sessions.size >= 1024) {
        for (const [id, entry] of sessions) {
          if (entry.pending.size === 0 && entry.compactionRunning !== true) {
            sessions.delete(id);
            if (sessions.size < 1024) break;
          }
        }
      }
      state = { revision: 0, pending: new Map(), compactions: new Set(), activeCompaction: false, compactionRunning: null };
      sessions.set(sessionID, state);
    }
    return state;
  };

  const processEvent = (event) => {
    const type = event?.type;
    if (type === 'session.compaction.delta') return;
    if (!type?.startsWith('session.inbox.') && !type?.startsWith('session.compaction.') && type !== 'session.deleted') return;
    const body = event.data ?? event.properties;
    const sessionID = body?.sessionID ?? body?.info?.id;
    if (typeof sessionID !== 'string' || !sessionID) return;
    bindRuntime();
    if (type === 'session.deleted') {
      sessions.delete(sessionID);
      return;
    }
    const state = stateFor(sessionID);
    state.revision += 1;
    const id = body.inboxID ?? body.id;
    if (type === 'session.inbox.enqueued') {
      if (body.item?.type === 'compaction' && typeof id === 'string') {
        state.compactions.add(id);
        state.compactionRunning = true;
      }
      if (body.item?.type === 'user' && typeof id === 'string') {
        state.pending.set(id, body.item.delivery === 'queue' ? 'queue' : 'steer');
      }
    } else if (type === 'session.inbox.delivery.changed' && state.pending.has(id)) {
      if (body.delivery === 'queue' || body.delivery === 'steer') state.pending.set(id, body.delivery);
    } else if (type === 'session.inbox.cancelled' || type === 'session.inbox.delivered') {
      state.pending.delete(id);
      if (state.compactions.delete(id) && type === 'session.inbox.cancelled' && !state.activeCompaction) {
        state.compactionRunning = state.compactions.size > 0;
      }
    } else if (type === 'session.compaction.started') {
      state.activeCompaction = true;
      state.compactionRunning = true;
    } else if (type === 'session.compaction.ended' || type === 'session.compaction.failed') {
      state.activeCompaction = false;
      state.compactions.clear();
      state.compactionRunning = false;
    }
  };

  const readSnapshot = async (sessionID, loadInbox) => {
    const state = stateFor(sessionID);
    const capturedRuntime = runtimeIdentity;
    // An event racing a read invalidates that read, never overwrites live state.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = state.revision;
      const payload = await loadInbox();
      const items = Array.isArray(payload) ? payload : payload?.data;
      if (!Array.isArray(items)) throw new Error('Invalid session inbox snapshot');
      if (getRuntimeIdentity() !== capturedRuntime || sessions.get(sessionID) !== state) throw new Error('Session delivery scope changed');
      if (state.revision !== revision) continue;
      state.pending = new Map(items.filter((item) => item?.type === 'user').map((item) => [item.id, item.delivery]));
      state.compactions = new Set(items.filter((item) => item?.type === 'compaction').map((item) => item.id));
      if (state.compactions.size > 0) state.compactionRunning = true;
      return { data: items, compactionRunning: state.compactionRunning };
    }
    throw new Error('Session inbox changed during snapshot');
  };

  return { processEvent, readSnapshot, reset: () => sessions.clear() };
};

export const registerSessionDeliveryRoute = (app, { delivery, buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  app.get('/api/sessions/:sessionID/delivery', async (req, res) => {
    try {
      const sessionID = req.params.sessionID;
      const query = new URLSearchParams();
      if (typeof req.query.directory === 'string') query.set('directory', req.query.directory);
      const url = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}/inbox?${query}`);
      const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
      const snapshot = await delivery.readSnapshot(sessionID, async () => {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Session inbox unavailable (${response.status})`);
        return response.json();
      });
      res.json(snapshot);
    } catch {
      res.status(503).json({ error: 'Session delivery state unavailable' });
    }
  });
};
