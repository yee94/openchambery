import { projectSessionMessageRecords } from '../session-turn-pages/session-message-projection.js';
import { projectSearchRecord } from './service.js';
import { normalizeSessionEventType } from '../session-metadata/session-projection.js';

const RETENTION = 30 * 24 * 60 * 60 * 1000;
const nextCursor = (page) => typeof page?.cursor?.next === 'string' ? page.cursor.next : null;

export function createContentSearchRuntime({ service, getRuntimeKey, getEventRuntimeKey = getRuntimeKey, listSessions, getSession, listMessages, now = Date.now }) {
  let stopped = false;
  let flight;
  let timer;
  let due = 0;
  let controller;
  let state = { runtime: getRuntimeKey(), phase: 'pending', since: now() - RETENTION, total: 0, completed: 0, failed: 0, updatedAt: null };
  const dirty = new Set();
  const deleted = new Set();
  const status = () => {
    const runtime = getRuntimeKey();
    if (!stopped && state.runtime !== runtime) schedule(0);
    const coverage = service.coverage(runtime);
    return { ...(state.runtime === runtime ? state : { runtime, phase: 'pending', since: now() - RETENTION, total: 0, completed: 0, failed: 0, updatedAt: null }),
      ...coverage, initializationRequired: coverage.indexCompletedAt === null, ...service.stats(runtime) };
  };
  const sync = ({ incremental = false } = {}) => {
    if (stopped) return Promise.resolve();
    if (flight) return flight;
    const runtime = getRuntimeKey();
    controller = new AbortController();
    const signal = controller.signal;
    const current = () => !stopped && runtime === getRuntimeKey() && !signal.aborted;
    if (state.runtime !== runtime) { dirty.clear(); deleted.clear(); }
    const previous = state.runtime === runtime ? state.updatedAt : null;
    state = { runtime, phase: previous ? 'ready' : 'indexing', since: now() - RETENTION, total: state.total, completed: 0, failed: 0, updatedAt: previous };
    flight = (async () => {
      if (service.coverage(runtime).indexCompletedAt === null) service.beginInitialization(runtime, now());
      const revisions = new Map(service.pending(runtime).map(({ id, revision }) => [id, revision]));
      for (const id of revisions.keys()) dirty.add(id);
      const pendingDirty = new Set(dirty);
      const initialized = service.coverage(runtime).indexCompletedAt !== null;
      const scanCatalog = !incremental || !initialized || service.needsEventIdentityRepair(runtime);
      const sessions = [];
      const ids = new Set();
      let cursor;
      let completeCatalog = scanCatalog;
      const cursors = new Set();
      if (!scanCatalog) {
        for (const sessionID of pendingDirty) {
          try {
            const session = await getSession({ sessionID, signal });
            if (!current()) return;
            if (!session?.id || !Number.isFinite(session.time?.updated)) throw new Error('Invalid dirty session');
            if (!session.parentID && session.time.updated >= state.since && !deleted.has(sessionID)) sessions.push(session);
            else {
              service.removeSession(runtime, sessionID);
              dirty.delete(sessionID);
            }
          } catch (error) {
            if (!current()) return;
            if ((error?.status ?? error?.response?.status) === 404) {
              service.removeSession(runtime, sessionID);
              dirty.delete(sessionID);
            } else state.failed++;
          }
        }
      } else do {
        const page = await listSessions({ limit: 100, ...(cursor ? { cursor } : { order: 'desc' }), signal });
        if (!current()) return;
        if (!Array.isArray(page?.data)) throw new Error('Invalid global session page');
        for (const session of page.data) {
          if (typeof session?.id !== 'string' || !session.id || !Number.isFinite(session.time?.updated)) throw new Error('Invalid global session checkpoint');
          if (typeof session.parentID === 'string' && session.parentID) continue;
          if (ids.has(session.id)) continue;
          ids.add(session.id);
          if (Number(session.time?.updated) >= state.since && !deleted.has(session.id)) sessions.push(session);
        }
        cursor = nextCursor(page);
        if (cursor && cursors.has(cursor)) throw new Error('Repeated session cursor');
        if (cursor) cursors.add(cursor);
        if (page.data.some((session) => session.time.updated < state.since)) {
          completeCatalog = !cursor;
          break;
        }
      } while (cursor && current());
      state.total = sessions.length;
      state.completed = 0;
      const recentIDs = new Set(sessions.map((session) => session.id));
      // A time-bounded catalog cannot classify pending IDs outside its pages.
      // Resolve those IDs directly so excluded children/expired roots cannot
      // keep initialization dirty forever. Failed reads remain pending.
      if (scanCatalog && !completeCatalog) for (const sessionID of pendingDirty) if (!recentIDs.has(sessionID)) {
        try {
          const session = await getSession({ sessionID, signal });
          if (!current()) return;
          if (!session?.id || !Number.isFinite(session.time?.updated)) throw new Error('Invalid dirty session');
          if (!session.parentID && session.time.updated >= state.since && !deleted.has(sessionID)) {
            sessions.push(session);
            recentIDs.add(sessionID);
          } else {
            service.removeSession(runtime, sessionID);
            dirty.delete(sessionID);
          }
        } catch (error) {
          if (!current()) return;
          if ((error?.status ?? error?.response?.status) === 404) {
            service.removeSession(runtime, sessionID);
            dirty.delete(sessionID);
          } else state.failed++;
        }
      }
      state.total = sessions.length;
      if (scanCatalog && completeCatalog) for (const id of pendingDirty) if (!recentIDs.has(id)) {
        dirty.delete(id);
        service.acknowledge(runtime, id, revisions.get(id));
      }
      if (service.coverage(runtime).indexCompletedAt === null) state.phase = 'indexing';
      let index = 0;
      const worker = async () => {
        while (current() && index < sessions.length) {
          const session = sessions[index++];
          if (!dirty.has(session.id) && service.updated(runtime, session.id, state.since) === session.time?.updated) {
            state.completed++; continue;
          }
          dirty.delete(session.id);
          try {
            const records = new Map();
            let before;
            const seen = new Set();
            do {
              const page = await listMessages({ sessionID: session.id, limit: 100,
                ...(before ? { cursor: before } : { order: 'desc' }), signal });
              if (!current()) return;
              if (!Array.isArray(page?.data)) throw new Error('Invalid global message page');
              for (const record of projectSessionMessageRecords(page.data)) {
                if (record.info.time?.created < state.since) continue;
                const projected = projectSearchRecord(record);
                if (projected) records.set(projected.info.id, projected);
              }
              before = nextCursor(page);
              if (before && seen.has(before)) throw new Error('Repeated message cursor');
              if (before) seen.add(before);
              // Native pages are newest-first, including control records.
              if (page.data.length && page.data.every((record) => Number(record.time?.created) < state.since)) break;
            } while (before && current());
            if (current() && !deleted.has(session.id)) {
              service.replaceSession(runtime, session, [...records.values()], state.since, now());
              if (revisions.has(session.id)) service.acknowledge(runtime, session.id, revisions.get(session.id));
            }
            state.completed++;
          } catch {
            if (!current()) return;
            dirty.add(session.id);
            state.failed++;
          }
        }
      };
      await Promise.all([worker(), worker()]);
      if (current()) {
        service.prune(runtime, state.since, completeCatalog ? ids : undefined);
        state.phase = state.failed ? 'partial' : 'ready';
        state.updatedAt = now();
        if (!state.failed && !dirty.size) service.completeInitialization(runtime, state.since, state.updatedAt);
      }
    })().catch(() => {
      if (current()) state.phase = 'error';
    }).finally(() => { flight = undefined; });
    return flight;
  };
  const schedule = (delay) => {
    if (stopped || (timer && due <= Date.now() + delay)) return;
    if (timer) clearTimeout(timer);
    due = Date.now() + delay;
    timer = setTimeout(async () => {
      timer = undefined;
      await sync({ incremental: true });
      if (service.coverage(getRuntimeKey()).indexCompletedAt === null || service.needsEventIdentityRepair(getRuntimeKey()) || service.pending(getRuntimeKey()).length) schedule(30_000);
    }, delay);
    timer.unref?.();
  };
  return {
    sync, status,
    start() { schedule(0); },
    observe(event) {
      if (event.runtimeIdentity?.runtimeKey && event.runtimeIdentity.runtimeKey !== getEventRuntimeKey()) return;
      if (state.runtime !== getRuntimeKey()) schedule(0);
      const payload = event.payload?.payload ?? event.payload;
      const type = normalizeSessionEventType(payload?.type ?? '');
      if (!(type.startsWith('message.') || type.startsWith('session.'))) return;
      if (type.includes('.delta') || type.includes('.part.') || type.includes('.tool.') || type.includes('.reasoning.')) return;
      const data = payload.properties ?? payload.data ?? {};
      const id = data.sessionID ?? data.info?.sessionID ?? data.session?.id ?? (type.startsWith('session.') ? data.id ?? data.info?.id : undefined);
      if (id && type === 'session.deleted') { dirty.delete(id); deleted.add(id); service.removeSession(getRuntimeKey(), id); }
      else if (id) { dirty.add(id); service.markDirty(getRuntimeKey(), id); }
      if (!id) return;
      // Coalesce bursts; ongoing scans retain dirty IDs for the next pass.
      schedule(1000);
    },
    async stop() { stopped = true; clearTimeout(timer); controller?.abort(); await flight; },
  };
}
