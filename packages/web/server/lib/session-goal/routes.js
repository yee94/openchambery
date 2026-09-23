import crypto from 'node:crypto';
import {
  assertSessionGoalSupported,
  getSessionGoalCapability,
  isSessionGoalSupported,
  sessionGoalUnavailableMessage,
} from './capability.js';
import { deleteObjective, readObjective, writeObjective } from './objectives.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

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

const resolveTokenBudget = (value) => {
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return null;
};

/**
 * Build an active goal record accepted by parseGoalMetadata.
 * File-backed: objectiveFile true (objective may be empty).
 * Inline fallback: objective text required.
 */
const buildActiveGoalRecord = ({
  objective = '',
  objectiveFile = false,
  tokenBudget = null,
  statusReason = '',
  id = null,
} = {}) => {
  const now = Date.now();
  const inline = typeof objective === 'string' ? objective.trim() : '';
  return {
    id: typeof id === 'string' && id ? id : crypto.randomUUID(),
    status: 'active',
    objective: objectiveFile ? '' : inline,
    objectiveFile: objectiveFile === true,
    tokenBudget: resolveTokenBudget(tokenBudget),
    tokensUsed: 0,
    turnsUsed: 0,
    blockedStreak: 0,
    note: '',
    statusReason: typeof statusReason === 'string' ? statusReason : '',
    lastAccountedMessageID: '',
    // Fresh goal starts a new execution generation (0). Resume / pause bump it.
    executionGeneration: 0,
    createdAt: now,
    updatedAt: now,
  };
};

// OpenChamber-owned routes for file-backed goal objectives, keyed by session
// id (one goal per session; a new goal overwrites the old file). The UI
// writes the objective file before stamping the goal metadata (which only
// carries an `objectiveFile: true` flag), reads it back for display, and
// deletes it when the goal is removed.
//
// Host goal state lives in the session-metadata store. Create / resume need
// an injected persistSessionGoal; without it they return 503 rather than
// pretending success. GET remains readable for leftover files.
export function registerSessionGoalRoutes(app, deps = {}) {
  const {
    persistSessionGoal = null,
    readSessionMetadata = null,
    /** After create/resume persist — arm the goal loop (synthetic session.updated). */
    onGoalPersisted = null,
  } = deps;

  const notifyGoalPersisted = (sessionID, directory, persisted, goal) => {
    if (typeof onGoalPersisted !== 'function') return;
    try {
      const metadata = persisted
        && typeof persisted === 'object'
        && !Array.isArray(persisted)
        && persisted.openchamber
        ? persisted
        : { openchamber: { goal } };
      onGoalPersisted({ sessionID, directory: directory || '', metadata });
    } catch (error) {
      console.warn('[session-goal] onGoalPersisted failed:', error?.message || error);
    }
  };

  app.get('/api/goals/capability', (_req, res) => {
    res.json(getSessionGoalCapability());
  });

  app.post('/api/goals/:sessionId', async (req, res) => {
    if (refuseGoalMutation(res, 'create')) return;
    if (typeof persistSessionGoal !== 'function') {
      res.status(503).json({
        error: 'session goal persist is not configured',
        operation: 'create',
        capability: getSessionGoalCapability(),
      });
      return;
    }

    const sessionId = asNonEmptyString(req.params?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: 'a session id is required' });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const directory = asNonEmptyString(body.directory) || '';
    const objectiveText = typeof body.objective === 'string' ? body.objective : '';
    const tokenBudget = body.tokenBudget ?? body.goalTokenBudget ?? null;

    let objectiveFile = false;
    let inlineObjective = objectiveText;
    try {
      await writeObjective(sessionId, objectiveText);
      objectiveFile = true;
      inlineObjective = '';
    } catch (error) {
      console.warn('[session-goal] objective file write failed, using inline objective:', error?.message || error);
      if (!asNonEmptyString(inlineObjective)) {
        res.status(400).json({ error: 'objective is required when the objective file cannot be written' });
        return;
      }
    }

    const goal = buildActiveGoalRecord({
      objective: inlineObjective,
      objectiveFile,
      tokenBudget,
    });

    let persisted;
    try {
      persisted = await persistSessionGoal(sessionId, directory, goal);
    } catch (error) {
      const message = error?.message || 'Failed to persist session goal';
      console.error('[session-goal] create persist failed:', message);
      res.status(500).json({ error: message, operation: 'create' });
      return;
    }

    notifyGoalPersisted(sessionId, directory, persisted, goal);
    res.json({ ok: true, goal });
  });

  app.post('/api/goals/:sessionId/resume', async (req, res) => {
    if (refuseGoalMutation(res, 'resume')) return;
    if (typeof persistSessionGoal !== 'function') {
      res.status(503).json({
        error: 'session goal persist is not configured',
        operation: 'resume',
        capability: getSessionGoalCapability(),
      });
      return;
    }
    if (typeof readSessionMetadata !== 'function') {
      res.status(503).json({
        error: 'session goal metadata read is not configured',
        operation: 'resume',
        capability: getSessionGoalCapability(),
      });
      return;
    }

    const sessionId = asNonEmptyString(req.params?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: 'a session id is required' });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const directory = asNonEmptyString(body.directory) || '';

    let metadata;
    try {
      metadata = await readSessionMetadata(sessionId);
    } catch (error) {
      const message = error?.message || 'Failed to read session metadata';
      console.error('[session-goal] resume read failed:', message);
      res.status(503).json({ error: message, operation: 'resume' });
      return;
    }

    const currentGoal = metadata?.openchamber?.goal;
    if (!currentGoal || typeof currentGoal !== 'object') {
      res.status(404).json({ error: 'goal not found', operation: 'resume' });
      return;
    }

    const now = Date.now();
    const priorGeneration = Number.isFinite(currentGoal.executionGeneration)
      && currentGoal.executionGeneration >= 0
      ? Math.floor(currentGoal.executionGeneration)
      : 0;
    const goal = {
      ...currentGoal,
      status: 'active',
      statusReason: 'resumed',
      // Resume opens a new execution generation so late audits from the prior
      // active period cannot commit continue/settle.
      executionGeneration: priorGeneration + 1,
      updatedAt: now,
    };

    let persisted;
    try {
      persisted = await persistSessionGoal(sessionId, directory, goal);
    } catch (error) {
      const message = error?.message || 'Failed to persist session goal';
      console.error('[session-goal] resume persist failed:', message);
      res.status(500).json({ error: message, operation: 'resume' });
      return;
    }

    notifyGoalPersisted(sessionId, directory, persisted, goal);
    res.json({ ok: true, goal });
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
