import { createChatCompletion, LlmError } from './completions.js';
import { loadConnectedCatalog } from './catalog.js';
import { OpenCode } from '@opencode/client';
import { ensureLlmTempDirectory } from './temp-directory.js';

const fail = (res, error) => {
  const code = error instanceof LlmError ? error.code : error?.code || 'internal_error';
  const status = error instanceof LlmError
    ? error.statusCode
    : code === 'no_provider'
      ? 400
      : code === 'validation_error'
        ? 400
        : code === 'llm_attachment_generation_unavailable'
          ? 502
          : code === 'upstream_error'
            ? 502
            : 500;
  res.status(status).json({ ok: false, error: code, message: error?.message || code });
};

export const registerLlmRoutes = (app, dependencies) => {
  const client = () => OpenCode.make({
    baseUrl: dependencies.buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: dependencies.getOpenCodeAuthHeaders(),
  });

  app.get('/api/openchamber/llm/models', (_req, res) => {
    Promise.resolve()
      .then(() => loadConnectedCatalog(client()))
      .then((catalog) => res.json({ ok: true, ...catalog }))
      .catch((error) => fail(res, error));
  });

  app.post('/api/openchamber/llm/chat/completions', (req, res) => {
    Promise.resolve()
      .then(() => createChatCompletion({
        body: req.body,
        buildOpenCodeUrl: dependencies.buildOpenCodeUrl,
        getOpenCodeAuthHeaders: dependencies.getOpenCodeAuthHeaders,
        clientFactory: client,
        ensureTempDirectory: ensureLlmTempDirectory,
        persistSessionMetadata: dependencies.persistSessionMetadata,
        onSystemSessionPersisted: dependencies.onSystemSessionPersisted,
      }))
      .then(({ completion }) => {
        res.status(200).json(completion);
      })
      .catch((error) => fail(res, error));
  });
};
