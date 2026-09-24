/**
 * HTTP surface for OpenChamber-owned session metadata and Host archive.
 *
 * OpenCode 2.x has no session-metadata update route. Clients (and Host
 * features such as session goal) merge-patch state here; the proxy folds the
 * store back onto session list/detail responses.
 *
 * Archive is a separate Host operation:
 * `PUT /api/openchamber/sessions/:sessionId/archive` body `{ archivedAt: number }`.
 *
 * This module exports the store factory, archive service helpers, and the route
 * registrar. Wire them from `server/index.js` / `feature-routes-runtime.js`.
 */

import express from 'express';

import { withGoalExecutionGeneration } from '../session-goal/runtime.js';
import { createSessionMetadataStore } from './session-metadata-store.js';
import { SessionArchiveError } from './session-archive.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {{ get: Function, setSessionMetadata: Function }} deps.sessionMetadataStore
 * @param {{ setArchive: Function } | null} [deps.sessionArchiveService]
 * @param {(event: { type: string, properties: object }) => void} [deps.broadcastGlobalUiEvent]
 * @param {(event: { sessionID: string, directory: string, metadata: object }) => void} [deps.onMetadataWritten]
 */
export const registerSessionMetadataRoutes = (app, deps = {}) => {
  const {
    sessionMetadataStore = null,
    sessionArchiveService = null,
    broadcastGlobalUiEvent = null,
    onMetadataWritten = null,
  } = deps;

  if (!sessionMetadataStore || typeof sessionMetadataStore.setSessionMetadata !== 'function') {
    throw new Error('registerSessionMetadataRoutes requires a sessionMetadataStore');
  }

  const putMetadata = async (req, res) => {
    const sessionId = asNonEmptyString(req.params?.sessionId);
    if (!sessionId) {
      return res.status(400).json({ error: 'a session id is required' });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const patch = body.patch;
    if (!isPlainObject(patch)) {
      return res.status(400).json({ error: 'patch must be an object' });
    }

    try {
      // Goal pause/resume/condition writes must advance executionGeneration so
      // in-flight audits lose commit rights. Normalize inside the exclusive
      // mutate boundary (same lock as persist) for UI merge-patches.
      let metadata;
      if (
        typeof sessionMetadataStore.mutateSessionMetadata === 'function'
        && isPlainObject(patch.openchamber)
        && Object.prototype.hasOwnProperty.call(patch.openchamber, 'goal')
        && isPlainObject(patch.openchamber.goal)
      ) {
        const result = await sessionMetadataStore.mutateSessionMetadata(sessionId, (current) => {
          const previousGoal = isPlainObject(current?.openchamber?.goal)
            ? current.openchamber.goal
            : null;
          return {
            ok: true,
            patch: {
              ...patch,
              openchamber: {
                ...patch.openchamber,
                goal: withGoalExecutionGeneration(previousGoal, patch.openchamber.goal),
              },
            },
          };
        }, {
          directory: asNonEmptyString(body.directory) || undefined,
        });
        if (!result?.committed) {
          throw new Error(result?.reason || 'session metadata mutate was rejected');
        }
        metadata = result.metadata;
      } else {
        metadata = await sessionMetadataStore.setSessionMetadata(sessionId, patch, {
          directory: asNonEmptyString(body.directory) || undefined,
        });
      }
      const directory = asNonEmptyString(body.directory) || '';
      if (typeof onMetadataWritten === 'function') {
        try {
          onMetadataWritten({ sessionID: sessionId, directory, metadata });
        } catch (error) {
          console.warn('[session-metadata] metadata listener failed:', error?.message ?? error);
        }
      }
      if (typeof broadcastGlobalUiEvent === 'function') {
        try {
          broadcastGlobalUiEvent({
            type: 'openchamber:session-metadata',
            properties: { sessionID: sessionId, metadata },
          });
        } catch (error) {
          console.warn('[session-metadata] broadcast failed:', error?.message ?? error);
        }
      }
      return res.json({ metadata });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to store session metadata';
      // Load/read failure must not be answered as empty success — clients must
      // not treat a refused write as cleared metadata.
      const status = /could not be read|unavailable/i.test(message) ? 503 : 500;
      console.error('[session-metadata] failed to store session metadata:', message);
      return res.status(status).json({ error: message });
    }
  };

  const putArchive = async (req, res) => {
    if (!sessionArchiveService || typeof sessionArchiveService.setArchive !== 'function') {
      return res.status(503).json({ error: 'session archive is not configured' });
    }

    const sessionId = asNonEmptyString(req.params?.sessionId);
    if (!sessionId) {
      return res.status(400).json({ error: 'a session id is required' });
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (typeof body.archivedAt !== 'number' || !Number.isFinite(body.archivedAt)) {
      return res.status(400).json({ error: 'archivedAt must be a finite number' });
    }

    try {
      const result = await sessionArchiveService.setArchive({
        sessionID: sessionId,
        archivedAt: body.archivedAt,
        directory: asNonEmptyString(body.directory) || undefined,
      });
      // Metadata is committed; index may report retryable failure separately.
      return res.json({
        session: result.session,
        ...(result.index ? { index: result.index } : {}),
      });
    } catch (error) {
      if (error instanceof SessionArchiveError) {
        return res.status(error.status || 400).json({
          error: error.message,
          code: error.code,
        });
      }
      const message = error instanceof Error ? error.message : 'Failed to archive session';
      const status = /could not be read|unavailable/i.test(message) ? 503 : 500;
      console.error('[session-archive] failed:', message);
      return res.status(status).json({ error: message });
    }
  };

  app.put(
    '/api/openchamber/sessions/:sessionId/metadata',
    express.json({ limit: '1mb' }),
    putMetadata,
  );

  app.put(
    '/api/openchamber/sessions/:sessionId/archive',
    express.json({ limit: '32kb' }),
    putArchive,
  );
};

export { createSessionMetadataStore, mergeMetadataPatch } from './session-metadata-store.js';
export {
  createSessionArchiveService,
  createUpstreamSessionFetcher,
  SessionArchiveError,
} from './session-archive.js';
export {
  projectSessionWithHostMetadata,
  projectSessionWithStoredMap,
  projectSessionLifecyclePayload,
  resolveProjectedArchivedAt,
  readHostArchivedAt,
  isSessionArchived,
  normalizeSessionEventType,
  extractSessionInfoFromPayload,
  resolveSessionDirectory,
  isSessionLifecycleEventType,
} from './session-projection.js';
