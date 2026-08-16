import express from 'express';

import { hasPreviewProxyCredential } from '../opencode/core-routes.js';
import {
  TranscriptCacheValidationError,
  parseTranscriptCacheEvict,
  parseTranscriptCacheGeneration,
  parseTranscriptCacheMessageID,
  parseTranscriptCacheScope,
  parseTranscriptCacheUpsert,
} from './service.js';

export const TRANSCRIPT_CACHE_ROUTE_PREFIX = '/api/openchamber/transcript-cache';

const unsupported = (res) => res.status(501).json({ error: 'Transcript cache is unavailable for this runtime' });

const forbiddenPreviewProxy = (res) => res.status(403).json({ error: 'Forbidden' });

const rejectPreviewProxyCredential = (handler) => (req, res) => {
  if (hasPreviewProxyCredential(req)) return forbiddenPreviewProxy(res);
  return handler(req, res);
};

const parseJson = express.json({ limit: '72mb' });

const withJson = (handler) => (req, res) => {
  // Unit tests and already-parsed middleware pass a body object; only raw
  // HTTP requests need the local JSON parser (this prefix is not in core-routes).
  if (req.body !== undefined) return handler(req, res);
  parseJson(req, res, (error) => {
    if (error) {
      return res.status(400).json({ error: 'Invalid transcript cache payload' });
    }
    handler(req, res);
  });
};

const sendError = (res, error) => {
  if (error instanceof TranscriptCacheValidationError) {
    return res.status(400).json({ error: error.message });
  }
  // Never log bodies, parts, or tokens — sqlite errors can embed SQL with content.
  console.error('[transcript-cache] request failed');
  return res.status(500).json({ error: 'Transcript cache request failed' });
};

const scopeFromQuery = (query = {}) => parseTranscriptCacheScope({
  transport: query.transport,
  generation: query.generation,
  directory: query.directory,
  sessionID: query.sessionID,
});

const scopeFromBody = (body) => parseTranscriptCacheScope(body?.scope ?? body);

export const registerTranscriptCacheRoutes = (app, { transcriptCacheService } = {}) => {
  app.get(`${TRANSCRIPT_CACHE_ROUTE_PREFIX}/session`, rejectPreviewProxyCredential((req, res) => {
    if (!transcriptCacheService) return unsupported(res);
    try {
      res.json({ available: true, ...transcriptCacheService.readSession(scopeFromQuery(req.query)) });
    } catch (error) {
      sendError(res, error);
    }
  }));

  app.get(`${TRANSCRIPT_CACHE_ROUTE_PREFIX}/message`, rejectPreviewProxyCredential((req, res) => {
    if (!transcriptCacheService) return unsupported(res);
    try {
      const record = transcriptCacheService.readMessage(
        scopeFromQuery(req.query),
        parseTranscriptCacheMessageID(req.query?.messageID),
      );
      if (!record) return res.status(404).json({ error: 'message_not_found' });
      res.json({ available: true, record });
    } catch (error) {
      sendError(res, error);
    }
  }));

  app.put(`${TRANSCRIPT_CACHE_ROUTE_PREFIX}/message`, rejectPreviewProxyCredential(withJson((req, res) => {
    if (!transcriptCacheService) return unsupported(res);
    try {
      const { scope, info, parts } = parseTranscriptCacheUpsert(req.body ?? {});
      res.json(transcriptCacheService.upsertSettled(scope, info, parts));
    } catch (error) {
      sendError(res, error);
    }
  })));

  app.delete(`${TRANSCRIPT_CACHE_ROUTE_PREFIX}/message`, rejectPreviewProxyCredential(withJson((req, res) => {
    if (!transcriptCacheService) return unsupported(res);
    try {
      const body = req.body ?? {};
      transcriptCacheService.removeMessage(
        scopeFromBody(body),
        parseTranscriptCacheMessageID(body.messageID),
      );
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  })));

  app.delete(`${TRANSCRIPT_CACHE_ROUTE_PREFIX}/session`, rejectPreviewProxyCredential(withJson((req, res) => {
    if (!transcriptCacheService) return unsupported(res);
    try {
      transcriptCacheService.clearSession(scopeFromBody(req.body ?? {}));
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  })));

  app.delete(`${TRANSCRIPT_CACHE_ROUTE_PREFIX}/generation`, rejectPreviewProxyCredential(withJson((req, res) => {
    if (!transcriptCacheService) return unsupported(res);
    try {
      transcriptCacheService.clearGeneration(parseTranscriptCacheGeneration(req.body ?? {}));
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  })));

  app.delete(`${TRANSCRIPT_CACHE_ROUTE_PREFIX}/all`, rejectPreviewProxyCredential((req, res) => {
    if (!transcriptCacheService) return unsupported(res);
    try {
      transcriptCacheService.clearAll();
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  }));

  app.post(`${TRANSCRIPT_CACHE_ROUTE_PREFIX}/evict`, rejectPreviewProxyCredential(withJson((req, res) => {
    if (!transcriptCacheService) return unsupported(res);
    try {
      const { maxBytes, protect } = parseTranscriptCacheEvict(req.body ?? {});
      res.json(transcriptCacheService.evictToBytes(maxBytes, { protect }));
    } catch (error) {
      sendError(res, error);
    }
  })));
};
