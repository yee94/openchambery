/**
 * HTTP contract for the browser-provider host.
 *
 * These routes are not in the common JSON allowlist, so each mutating route
 * parses its own body. A missing parser would turn every action into a
 * validation failure and hide that the provider was never asked.
 *
 * List failure is never `{ providers: [] }`. Action failure is never
 * `{ ok: true, data: {} }`.
 */

import express from 'express';

import {
  BROWSER_PROVIDER_ACTIONS_ROUTE,
  BROWSER_PROVIDER_SELECTION_ROUTE,
  BROWSER_PROVIDERS_ROUTE,
  BrowserProviderError,
} from './contract.js';

const parseSelection = express.json({ limit: '4kb' });
const parseAction = express.json({ limit: '64kb' });

const readJson = (parser, invalid) => (req, res, next) => {
  parser(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    const status = error.status || error.statusCode || 400;
    res.status(status).json(invalid);
  });
};

const catalogError = (res, error) => {
  if (error instanceof BrowserProviderError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(503).json({
    error: 'OpenChamber could not read the browser provider catalog.',
    code: 'CATALOG_UNAVAILABLE',
  });
};

const actionError = (res, error) => {
  if (error instanceof BrowserProviderError) {
    res.status(error.status).json({ ok: false, code: error.code, error: error.message });
    return;
  }
  res.status(500).json({
    ok: false,
    code: 'PROVIDER_UNAVAILABLE',
    error: 'The browser action was not completed. Nothing is known about the page.',
  });
};

/**
 * @param {import('express').Express} app
 * @param {{ host: { list: Function, selectedId: Function, select: Function, dispatchAgentBrowserAction: Function } }} deps
 */
export const registerBrowserProviderRoutes = (app, { host }) => {
  if (!host || typeof host.catalog !== 'function' || typeof host.dispatchAgentBrowserAction !== 'function') {
    throw new Error('registerBrowserProviderRoutes requires a browser provider host');
  }

  app.get(BROWSER_PROVIDERS_ROUTE, async (_req, res) => {
    try {
      res.json(await host.catalog());
    } catch (error) {
      catalogError(res, error);
    }
  });

  app.put(BROWSER_PROVIDER_SELECTION_ROUTE, readJson(parseSelection, {
    error: 'The selection body could not be read. The selection was not changed.',
    code: 'INVALID_SELECTION',
  }), async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string') {
      res.status(400).json({
        error: 'id is required and must be a browser provider id. The selection was not changed.',
        code: 'INVALID_SELECTION',
      });
      return;
    }
    try {
      const selectedId = await host.select(body.id);
      res.json({ selectedId });
    } catch (error) {
      catalogError(res, error);
    }
  });

  app.post(BROWSER_PROVIDER_ACTIONS_ROUTE, readJson(parseAction, {
    ok: false,
    code: 'INVALID_ACTION',
    error: 'The action body could not be read. Nothing was sent.',
  }), async (req, res) => {
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const result = await host.dispatchAgentBrowserAction({
        action: body.action,
        parameters: body.parameters,
        context: body.context,
        providerId: body.providerId,
        signal: controller.signal,
      });
      res.json({ ok: true, providerId: result.providerId, data: result.data });
    } catch (error) {
      if (res.headersSent || res.writableEnded) return;
      actionError(res, error);
    } finally {
      res.off('close', onClose);
    }
  });
};
