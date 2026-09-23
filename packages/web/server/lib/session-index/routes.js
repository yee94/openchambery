import {
  applyHostArchiveToIndexSnapshot,
  applyHostArchiveToLookupHit,
} from './host-authority-snapshot.js';

const unsupported = (res) => res.status(501).json({ error: 'Session index is unavailable for this runtime' });

/**
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {object | null} deps.sessionIndexService
 * @param {object | null} [deps.sessionIndexSyncRuntime]
 * @param {() => Promise<Record<string, object>> | Record<string, object> | null} [deps.getCommittedHostMetadata]
 *   Committed Host metadata map. Throws / returns null on unavailable → 503.
 */
export const registerSessionIndexRoutes = (app, {
  sessionIndexService,
  sessionIndexSyncRuntime,
  getCommittedHostMetadata = null,
} = {}) => {
  const hostStoreWired = typeof getCommittedHostMetadata === 'function';

  const readHostMap = async () => {
    if (!hostStoreWired) return { status: 'unconfigured', stored: {} };
    try {
      const stored = await getCommittedHostMetadata();
      if (stored == null || typeof stored !== 'object') {
        return { status: 'unavailable', error: 'session metadata is unavailable' };
      }
      return { status: 'ok', stored };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'session metadata is unavailable';
      return { status: 'unavailable', error: message };
    }
  };

  const metadataUnavailable = (res, error) => res.status(503).json({
    error: error || 'session metadata is unavailable',
    code: 'session_metadata_unavailable',
    retryable: true,
  });

  app.get('/api/openchamber/session-index', async (_req, res) => {
    if (!sessionIndexService) return unsupported(res);
    const base = sessionIndexSyncRuntime?.snapshot() ?? sessionIndexService.snapshot();
    if (!hostStoreWired) {
      return res.json({ available: true, ...base });
    }
    const host = await readHostMap();
    if (host.status === 'unavailable') return metadataUnavailable(res, host.error);
    const filtered = applyHostArchiveToIndexSnapshot(base, host.stored);
    return res.json({ available: true, ...filtered });
  });

  app.post('/api/openchamber/session-index/sync', (req, res) => {
    if (!sessionIndexSyncRuntime) return unsupported(res);
    const directories = Array.isArray(req.body?.directories) ? req.body.directories : [];
    res.status(202).json(sessionIndexSyncRuntime.enqueue(directories));
  });

  app.put('/api/openchamber/session-index/directory', (req, res) => {
    if (!sessionIndexService) return unsupported(res);
    try {
      sessionIndexService.replaceDirectory(req.body ?? {});
      res.status(204).end();
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid session index payload' });
    }
  });

  app.put('/api/openchamber/session-index/snapshot', (req, res) => {
    if (!sessionIndexService) return unsupported(res);
    try {
      sessionIndexService.replaceDirectories(req.body?.directories);
      res.status(204).end();
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid session index payload' });
    }
  });

  app.post('/api/openchamber/session-index/session', (req, res) => {
    if (!sessionIndexService) return unsupported(res);
    res.status(sessionIndexService.upsert(req.body?.session) ? 204 : 400).end();
  });

  app.delete('/api/openchamber/session-index/session/:sessionId', (req, res) => {
    if (!sessionIndexService) return unsupported(res);
    sessionIndexService.remove(req.params.sessionId);
    res.status(204).end();
  });

  // Deep-link resolution: GET by session id without requiring a directory.
  app.get('/api/openchamber/session-index/session/:sessionId', async (req, res) => {
    if (!sessionIndexService) return unsupported(res);
    if (typeof sessionIndexService.findBySessionId !== 'function') {
      return res.status(501).json({ error: 'Session lookup is unavailable' });
    }
    const sessionId = req.params.sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const id = sessionId.trim();
    const hit = sessionIndexService.findBySessionId(id);
    if (!hit) {
      return res.status(404).json({ error: 'session_not_found', sessionId: id });
    }
    if (!hostStoreWired) {
      return res.json({ available: true, session: hit });
    }
    const host = await readHostMap();
    if (host.status === 'unavailable') return metadataUnavailable(res, host.error);
    const projected = applyHostArchiveToLookupHit(hit, host.stored);
    if (!projected || projected.hidden) {
      return res.status(404).json({ error: 'session_not_found', sessionId: id });
    }
    return res.json({ available: true, session: projected.session });
  });

  app.post('/api/openchamber/session-index/session/:id/pin', (req, res) => {
    if (!sessionIndexService) return unsupported(res);
    if (typeof sessionIndexService.setPinned !== 'function') {
      return res.status(501).json({ error: 'Session pin is unavailable' });
    }
    const sessionId = req.params.id;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const changed = sessionIndexService.setPinned(sessionId.trim());
    if (!changed) {
      return res.status(404).json({ error: 'session_not_found', sessionId: sessionId.trim() });
    }
    sessionIndexSyncRuntime?.publishChange?.();
    res.status(204).end();
  });

  app.delete('/api/openchamber/session-index/session/:id/pin', (req, res) => {
    if (!sessionIndexService) return unsupported(res);
    if (typeof sessionIndexService.clearPinned !== 'function') {
      return res.status(501).json({ error: 'Session unpin is unavailable' });
    }
    const sessionId = req.params.id;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const changed = sessionIndexService.clearPinned(sessionId.trim());
    if (!changed) {
      return res.status(404).json({ error: 'session_not_found', sessionId: sessionId.trim() });
    }
    sessionIndexSyncRuntime?.publishChange?.();
    res.status(204).end();
  });
};
