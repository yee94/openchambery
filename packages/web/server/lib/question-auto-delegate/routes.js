import { QUESTION_SUBMISSION_CLAIMED_CODE } from './core.js';

const asTrimmedString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

const readDirectory = (req) => {
  const fromQuery = asTrimmedString(
    Array.isArray(req.query?.directory) ? req.query.directory[0] : req.query?.directory,
  );
  if (fromQuery) return fromQuery;
  const fromBody = asTrimmedString(req.body?.directory);
  if (fromBody) return fromBody;
  const header = req.headers?.['x-opencode-directory'];
  if (typeof header === 'string' && header.trim()) {
    if (req.headers?.['x-opencode-directory-encoding'] === 'uri') {
      try {
        return decodeURIComponent(header.trim());
      } catch {
        return header.trim();
      }
    }
    return header.trim();
  }
  return '';
};

const sendMutation = (res, result) => {
  if (result.outcome === 'claimed') {
    return res.status(409).json({
      error: result.error || 'Question submission already claimed',
      code: result.code || QUESTION_SUBMISSION_CLAIMED_CODE,
      outcome: result.outcome,
      snapshot: result.snapshot,
    });
  }
  if (result.outcome === 'not_found') {
    return res.status(404).json({
      error: result.error || 'Not found',
      outcome: result.outcome,
      snapshot: result.snapshot,
    });
  }
  if (result.outcome === 'error') {
    return res.status(result.status || 500).json({
      error: result.error || 'Question auto-delegate error',
      outcome: result.outcome,
      snapshot: result.snapshot,
    });
  }
  if (result.outcome === 'disabled') {
    return res.status(409).json({
      error: result.error || 'Question auto-delegate is disabled',
      outcome: result.outcome,
      snapshot: result.snapshot,
    });
  }
  if (result.outcome === 'paused') {
    return res.json({
      outcome: result.outcome,
      snapshot: result.snapshot,
    });
  }
  return res.json({
    outcome: result.outcome,
    snapshot: result.snapshot,
    ...(result.upstreamStatus != null ? { upstreamStatus: result.upstreamStatus } : {}),
  });
};

/**
 * OpenChamber-owned question auto-delegate routes + precise intercepts for
 * `/api/question/:id/reply|reject` (must register before the generic OpenCode proxy).
 * Manual reply/reject keep the upstream SDK response shape/body on success.
 */
export function registerQuestionAutoDelegateRoutes(app, runtime) {
  app.get('/api/question-auto-delegate', (_req, res) => {
    try {
      res.json(runtime.snapshot());
    } catch (error) {
      res.status(500).json({ error: error?.message ?? 'Failed to read question auto-delegate snapshot' });
    }
  });

  app.post('/api/question-auto-delegate/requests/:requestID/pause', async (req, res) => {
    try {
      const result = await runtime.pause({
        requestID: req.params.requestID,
        sessionID: req.body?.sessionID,
        directory: req.body?.directory,
        reason: req.body?.reason,
      });
      return sendMutation(res, result);
    } catch (error) {
      return res.status(500).json({ error: error?.message ?? 'Failed to pause question auto-delegate' });
    }
  });

  app.post('/api/question-auto-delegate/requests/:requestID/delegate', async (req, res) => {
    try {
      const result = await runtime.delegate({
        requestID: req.params.requestID,
        sessionID: req.body?.sessionID,
        directory: req.body?.directory,
      });
      return sendMutation(res, result);
    } catch (error) {
      return res.status(500).json({ error: error?.message ?? 'Failed to delegate question' });
    }
  });

  // Precise intercepts — claim then forward to upstream via runtime IO.
  app.post('/api/question/:requestID/reply', async (req, res) => {
    try {
      const requestID = asTrimmedString(req.params.requestID);
      const directory = readDirectory(req);
      const sessionID = asTrimmedString(req.body?.sessionID);
      // Manual path: answers must be present as an array (including []). Never
      // substitute the auto-delegate fixed text.
      if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'answers')) {
        return res.status(400).json({ error: 'answers is required' });
      }
      if (!Array.isArray(req.body.answers)) {
        return res.status(400).json({ error: 'answers must be an array' });
      }

      const result = await runtime.submit({
        requestID,
        sessionID: sessionID || undefined,
        directory: directory || undefined,
        kind: 'reply',
        authority: 'manual',
        answers: req.body.answers,
        body: req.body,
      });

      if (result.outcome === 'claimed') {
        return res.status(409).json({
          error: result.error || 'Question submission already claimed',
          code: result.code || QUESTION_SUBMISSION_CLAIMED_CODE,
        });
      }
      if (result.outcome === 'uncertain') {
        return res.status(result.upstreamStatus && result.upstreamStatus >= 400 ? result.upstreamStatus : 502).json(
          result.upstreamBody ?? { error: result.error || 'Question reply uncertain' },
        );
      }
      if (result.outcome === 'not_found' || result.upstreamStatus === 404) {
        // Preserve upstream 404 body shape when present.
        if (result.upstreamBody != null) {
          return res.status(404).json(result.upstreamBody);
        }
        return res.status(404).json({ error: 'Question not found' });
      }
      if (result.outcome === 'submitted' || result.outcome === 'settled') {
        const status = result.upstreamStatus && result.upstreamStatus >= 200 ? result.upstreamStatus : 200;
        if (result.upstreamBody === null || result.upstreamBody === undefined) {
          // SDK optional unwrap expects boolean true on success for reply.
          return res.status(status).json(true);
        }
        return res.status(status).json(result.upstreamBody);
      }
      if (result.outcome === 'error') {
        // Definitive upstream reject (400/409/422) — preserve body when present.
        if (result.upstreamBody != null && result.upstreamStatus) {
          return res.status(result.upstreamStatus).json(result.upstreamBody);
        }
        return res.status(result.status || result.upstreamStatus || 500).json({
          error: result.error || 'Question reply failed',
        });
      }
      return res.status(result.upstreamStatus || 500).json(result.upstreamBody ?? { error: 'Question reply failed' });
    } catch (error) {
      return res.status(500).json({ error: error?.message ?? 'Question reply failed' });
    }
  });

  app.post('/api/question/:requestID/reject', async (req, res) => {
    try {
      const requestID = asTrimmedString(req.params.requestID);
      const directory = readDirectory(req);
      const sessionID = asTrimmedString(req.body?.sessionID);

      const result = await runtime.submit({
        requestID,
        sessionID: sessionID || undefined,
        directory: directory || undefined,
        kind: 'reject',
        authority: 'manual',
        body: req.body && typeof req.body === 'object' ? req.body : {},
      });

      if (result.outcome === 'claimed') {
        return res.status(409).json({
          error: result.error || 'Question submission already claimed',
          code: result.code || QUESTION_SUBMISSION_CLAIMED_CODE,
        });
      }
      if (result.outcome === 'uncertain') {
        return res.status(result.upstreamStatus && result.upstreamStatus >= 400 ? result.upstreamStatus : 502).json(
          result.upstreamBody ?? { error: result.error || 'Question reject uncertain' },
        );
      }
      if (result.outcome === 'not_found' || result.upstreamStatus === 404) {
        if (result.upstreamBody != null) {
          return res.status(404).json(result.upstreamBody);
        }
        return res.status(404).json({ error: 'Question not found' });
      }
      if (result.outcome === 'submitted' || result.outcome === 'settled') {
        const status = result.upstreamStatus && result.upstreamStatus >= 200 ? result.upstreamStatus : 200;
        if (result.upstreamBody === null || result.upstreamBody === undefined) {
          return res.status(status).json(true);
        }
        return res.status(status).json(result.upstreamBody);
      }
      if (result.outcome === 'error') {
        return res.status(result.status || 500).json({ error: result.error || 'Question reject failed' });
      }
      return res.status(result.upstreamStatus || 500).json(result.upstreamBody ?? { error: 'Question reject failed' });
    } catch (error) {
      return res.status(500).json({ error: error?.message ?? 'Question reject failed' });
    }
  });
}
