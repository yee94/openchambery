import { createChatCompletion, LlmError } from './completions.js';
import { loadConnectedCatalog } from './catalog.js';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { ensureLlmTempDirectory } from './temp-directory.js';

const fail = (res, error) => {
  const code = error instanceof LlmError ? error.code : error?.code || 'internal_error';
  const status = error instanceof LlmError
    ? error.statusCode
    : code === 'no_provider'
      ? 400
      : code === 'validation_error'
        ? 400
        : code === 'upstream_error'
          ? 502
          : 500;
  res.status(status).json({ ok: false, error: code, message: error?.message || code });
};

export const registerLlmRoutes = (app, dependencies) => {
  const client = () => createOpencodeClient({
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
      }))
      .then(({ completion }) => {
        res.status(200).json(completion);
      })
      .catch((error) => fail(res, error));
  });
};
