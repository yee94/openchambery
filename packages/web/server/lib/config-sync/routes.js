import { createConfigSyncReceiver } from './receiver.js';

/**
 * Register HTTP config-sync receive/download routes for direct (and later relay) hosts.
 * Auth is the global `/api` UI/client-token gate. Selected kinds (including auth)
 * sync when present in the plan — no extra credential grant checks.
 *
 * @param {import('express').Express} app
 * @param {{
 *   receiver?: ReturnType<typeof createConfigSyncReceiver>,
 *   express?: typeof import('express'),
 * }} deps
 */
export const registerConfigSyncRoutes = (app, deps = {}) => {
  const {
    express,
  } = deps;

  const receiver = deps.receiver || createConfigSyncReceiver();

  const sendError = (res, error, fallbackStatus = 500) => {
    const code = typeof error?.code === 'string' ? error.code : undefined;
    const status = code === 'sync_in_progress' ? 409
      : code === 'sync_not_prepared' ? 409
        : code === 'sync_payload_too_large' || code === 'sync_too_many_files' ? 413
          : code === 'sync_invalid_kind' ? 400
            : fallbackStatus;
    res.status(status).json({
      error: error instanceof Error ? error.message : String(error),
      ...(code ? { code } : {}),
      ...(error?.syncRunId ? { syncRunId: error.syncRunId } : {}),
    });
  };

  app.post('/api/openchamber/config-sync/probe', express?.json?.({ limit: '1mb' }) || ((req, _res, next) => next()), async (req, res) => {
    try {
      const plan = req.body?.plan && typeof req.body.plan === 'object' ? req.body.plan : {};
      const result = await receiver.probe(plan);
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/openchamber/config-sync/prepare', express?.json?.({ limit: '1mb' }) || ((req, _res, next) => next()), async (req, res) => {
    try {
      const plan = req.body?.plan && typeof req.body.plan === 'object' ? req.body.plan : null;
      const syncRunId = typeof req.body?.syncRunId === 'string' ? req.body.syncRunId.trim() : '';
      if (!plan || !syncRunId) {
        return res.status(400).json({ error: 'plan and syncRunId are required' });
      }
      const result = await receiver.prepare(plan, { syncRunId });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/openchamber/config-sync/put/:kind', async (req, res) => {
    try {
      const kind = String(req.params.kind || '').trim();
      const syncRunId = typeof req.query.syncRunId === 'string' ? req.query.syncRunId.trim() : '';
      if (!syncRunId) {
        return res.status(400).json({ error: 'syncRunId is required' });
      }
      const result = await receiver.put({ syncRunId, kind, stream: req });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/openchamber/config-sync/download/:kind', async (req, res) => {
    try {
      const kind = String(req.params.kind || '').trim();
      const buffer = await receiver.download({ kind });
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Length', String(buffer.byteLength));
      res.send(buffer);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/openchamber/config-sync/finalize', express?.json?.({ limit: '64kb' }) || ((req, _res, next) => next()), async (req, res) => {
    try {
      const syncRunId = typeof req.body?.syncRunId === 'string' ? req.body.syncRunId.trim() : '';
      if (!syncRunId) {
        return res.status(400).json({ error: 'syncRunId is required' });
      }
      const result = await receiver.finalize({ syncRunId });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/openchamber/config-sync/abort', express?.json?.({ limit: '64kb' }) || ((req, _res, next) => next()), async (req, res) => {
    try {
      const syncRunId = typeof req.body?.syncRunId === 'string' ? req.body.syncRunId.trim() : '';
      res.json(receiver.abort({ syncRunId: syncRunId || undefined }));
    } catch (error) {
      sendError(res, error);
    }
  });

  return { receiver };
};
