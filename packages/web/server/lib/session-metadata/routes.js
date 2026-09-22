/**
 * HTTP surface for OpenChamber-owned session metadata.
 *
 * OpenCode 2.x has no session-metadata update route. Clients (and Host
 * features such as session goal) merge-patch state here; the proxy folds the
 * store back onto session list/detail responses.
 *
 * This module exports the store factory and the route registrar. Wire them
 * from `server/index.js` (store instance, proxy `getStoredSessionMetadata`,
 * session-goal / scheduled-tasks `readSessionMetadata` / `persistSessionGoal`,
 * then `registerSessionMetadataRoutes`).
 */

import express from 'express';

import { createSessionMetadataStore } from './session-metadata-store.js';

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
  * @param {(event: { type: string, properties: object }) => void} [deps.broadcastGlobalUiEvent]
   * @param {(event: { sessionID: string, directory: string, metadata: object }) => void} [deps.onMetadataWritten]
   */
export const registerSessionMetadataRoutes = (app, deps = {}) => {
  const {
    sessionMetadataStore = null,
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
      const metadata = await sessionMetadataStore.setSessionMetadata(sessionId, patch);
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

  app.put(
    '/api/openchamber/sessions/:sessionId/metadata',
    express.json({ limit: '1mb' }),
    putMetadata,
  );
};

export { createSessionMetadataStore, mergeMetadataPatch } from './session-metadata-store.js';
