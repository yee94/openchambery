import { makeOpenCodeV2Client } from '../opencode/v2-client.js';
import { projectSessionWithHostMetadata, readSessionTitleAuthority } from '../session-metadata/session-projection.js';
import { randomUUID } from 'node:crypto';
import { projectSessionMessageRecords } from '../session-turn-pages/session-message-projection.js';

/** Title reads use OpenCode; title-refresh metadata and its notifications belong to the Host. */
export function createTitleSessionAccess({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSessionMetadata,
  persistSessionMetadata,
  mutateSessionMetadata,
  listSessionMetadata = async () => ({}),
  publishSession,
}) {
  const pending = new Map();
  let stopped = false;
  let recovery = null;
  let recoveryTimer = null;
  let recoveryFailures = 0;
  const client = () => makeOpenCodeV2Client({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    authHeaders: getOpenCodeAuthHeaders(),
  });
  const options = () => ({ signal: AbortSignal.timeout(30_000) });
  const get = async (sessionID) => {
    const session = await client().session.get({ sessionID }, options());
    const metadata = await readSessionMetadata(sessionID);
    const authority = readSessionTitleAuthority(sessionID, metadata);
    if (authority && authority.title !== session.title) reconcile(sessionID);
    return projectSessionWithHostMetadata(session, metadata);
  };

  // Coalesce only pending work; settled sessions retain no in-memory entry.
  const reconcile = (sessionID, directory = '') => {
    if (stopped || !sessionID) return;
    const existing = pending.get(sessionID);
    if (existing) { existing.dirty = true; return; }
    const state = { dirty: false, timer: null, failures: 0, repaired: false };
    pending.set(sessionID, state);
    const run = async () => {
      state.dirty = false;
      try {
        const metadata = await readSessionMetadata(sessionID);
        const authority = readSessionTitleAuthority(sessionID, metadata);
        if (!authority || stopped) { pending.delete(sessionID); return; }
        const session = await client().session.get({ sessionID }, options());
        if (stopped) return;
        if (session.title !== authority.title) {
          await client().session.update({ sessionID, title: authority.title }, options());
          state.repaired = true;
          // Always verify after a write, even if its echo was lost or reordered.
          state.dirty = true;
        } else {
          const latest = await readSessionMetadata(sessionID);
          if (readSessionTitleAuthority(sessionID, latest)?.revision !== authority.revision) {
            state.dirty = true;
          } else if (state.repaired && !stopped) {
            state.repaired = false;
            await publishSession(projectSessionWithHostMetadata(session, latest), directory);
          }
        }
        state.failures = 0;
      } catch (error) {
        if (Number(error?.status ?? error?.statusCode) === 404 || error?._tag === 'SessionNotFoundError') {
          pending.delete(sessionID);
          return;
        }
        state.failures += 1;
        state.dirty = true;
        if (state.failures === 1) console.warn('[session-title] reconciliation failed:', error?.message || error);
      } finally {
        if (stopped) { pending.delete(sessionID); return; }
        if (pending.get(sessionID) !== state) return;
        if (state.dirty) {
          state.timer = setTimeout(run, state.failures ? Math.min(60_000, 1000 * 2 ** Math.min(state.failures - 1, 6)) : 0);
          state.timer.unref?.();
        } else pending.delete(sessionID);
      }
    };
    state.timer = setTimeout(run, 0);
    state.timer.unref?.();
  };
  const reconcileAll = () => {
    if (stopped) return Promise.resolve();
    if (recovery) return recovery;
    clearTimeout(recoveryTimer);
    recovery = (async () => {
      const entries = await listSessionMetadata();
      recoveryFailures = 0;
      for (const [id, metadata] of Object.entries(entries)) {
        if (stopped) return;
        if (!readSessionTitleAuthority(id, metadata)) continue;
        // Serial discovery bounds reconnect reads; only drift queues repair.
        try { await get(id); } catch { reconcile(id); }
      }
    })().catch((error) => {
      recoveryFailures += 1;
      if (!stopped) {
        recoveryTimer = setTimeout(() => { void reconcileAll(); }, Math.min(60_000, 1000 * 2 ** Math.min(recoveryFailures - 1, 6)));
        recoveryTimer.unref?.();
      }
      if (recoveryFailures === 1) console.warn('[session-title] recovery failed:', error?.message || error);
    }).finally(() => { recovery = null; });
    return recovery;
  };
  return {
    get,
    reconcile,
    reconcileAll,
    stop() {
      stopped = true;
      clearTimeout(recoveryTimer);
      for (const state of pending.values()) clearTimeout(state.timer);
      pending.clear();
    },
    async messages(sessionID, _directory, limit) {
      const page = await client().message.list({ sessionID, limit, order: 'desc' }, options());
      if (!Array.isArray(page?.data)) throw new Error('Session title: invalid message page');
      return projectSessionMessageRecords([...page.data].reverse());
    },
    async update(sessionID, directory, patch) {
      if (stopped) return;
      if (typeof patch.title === 'string') {
        const result = await mutateSessionMetadata(sessionID, (metadata) => {
          const current = readSessionTitleAuthority(sessionID, metadata);
          if ((current?.revision ?? null) !== (patch.expectedTitleRevision ?? null)) return { ok: false };
          return { ok: true, patch: { openchamber: {
            titleAuthority: { sessionID, title: patch.title, revision: randomUUID(), source: 'summary' },
            titleRefresh: patch.metadata?.openchamber?.titleRefresh ?? {},
          } } };
        });
        if (!result.committed || stopped) return;
        // Durable intent survives failed writes and process restarts.
        reconcile(sessionID, directory);
        await client().session.update({ sessionID, title: patch.title }, options());
      }
      // Never write the complete metadata snapshot back: goal/archive/ownership
      // may have changed while the title model was running.
      const refresh = patch.metadata?.openchamber?.titleRefresh;
      if (refresh && typeof patch.title !== 'string') {
        await persistSessionMetadata(sessionID, { openchamber: { titleRefresh: refresh } });
      }
      if (typeof patch.title === 'string' || (refresh && Object.hasOwn(refresh, 'isGenerating'))) {
        const session = await get(sessionID);
        await publishSession(session, directory);
        return session;
      }
    },
  };
}
