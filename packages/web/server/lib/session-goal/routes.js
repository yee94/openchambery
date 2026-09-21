import {
  assertSessionGoalSupported,
  getSessionGoalCapability,
  isSessionGoalSupported,
  sessionGoalUnavailableMessage,
} from './capability.js';
import { deleteObjective, readObjective, writeObjective } from './objectives.js';

const refuseGoalMutation = (res, operation) => {
  try {
    assertSessionGoalSupported({ operation });
    return false;
  } catch (error) {
    const capability = error?.capability || getSessionGoalCapability();
    res.status(Number(error?.statusCode) || 501).json({
      error: error?.message || sessionGoalUnavailableMessage(capability),
      reason: capability.reason,
      capability,
      operation,
    });
    return true;
  }
};

// OpenChamber-owned routes for file-backed goal objectives, keyed by session
// id (one goal per session; a new goal overwrites the old file). The UI
// writes the objective file before stamping the goal metadata (which only
// carries an `objectiveFile: true` flag), reads it back for display, and
// deletes it when the goal is removed.
//
// Host goal state is unavailable on OpenCode v2 (no metadata.openchamber.goal).
// Create / resume / objective-write refuse via capability so callers do not
// treat objective hints as a registered goal. GET remains readable for leftover
// files; capability is exposed for a later UI lane.
export function registerSessionGoalRoutes(app) {
  app.get('/api/goals/capability', (_req, res) => {
    res.json(getSessionGoalCapability());
  });

  // Explicit create/resume entry points — refuse until Host goal state exists.
  // Prefer these over inventing metadata patches on the OpenCode proxy.
  app.post('/api/goals/:sessionId', (req, res) => {
    if (refuseGoalMutation(res, 'create')) return;
    res.status(501).json({
      error: sessionGoalUnavailableMessage(),
      reason: getSessionGoalCapability().reason,
      capability: getSessionGoalCapability(),
      operation: 'create',
    });
  });

  app.post('/api/goals/:sessionId/resume', (req, res) => {
    if (refuseGoalMutation(res, 'resume')) return;
    res.status(501).json({
      error: sessionGoalUnavailableMessage(),
      reason: getSessionGoalCapability().reason,
      capability: getSessionGoalCapability(),
      operation: 'resume',
    });
  });

  app.put('/api/goals/objective/:sessionId', async (req, res) => {
    // Objective write is part of manual goal create — refuse while unsupported
    // so create cannot partial-succeed on the file alone.
    if (refuseGoalMutation(res, 'create')) return;
    try {
      const { content } = req.body || {};
      await writeObjective(req.params.sessionId, content);
      res.json({ ok: true });
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('Failed to write goal objective:', error);
      }
      res.status(statusCode).json({ error: error?.message || 'Failed to write goal objective' });
    }
  });

  app.get('/api/goals/objective/:sessionId', async (req, res) => {
    const content = await readObjective(req.params.sessionId);
    if (content === null) {
      res.status(404).json({ error: 'objective not found' });
      return;
    }
    res.json({ content });
  });

  app.delete('/api/goals/objective/:sessionId', async (req, res) => {
    // Clear is allowed even when create is unsupported so leftover files from
    // prior experiments can be removed without implying goal Host support.
    await deleteObjective(req.params.sessionId);
    res.json({
      ok: true,
      ...(isSessionGoalSupported() ? {} : {
        capability: getSessionGoalCapability(),
      }),
    });
  });
}
