import { validateConversationInput } from './validation.js';
import { fingerprint, createOperationRegistry } from './registry.js';
import { createConversationsService } from './service.js';

export const registerConversationRoutes = (app, dependencies) => {
  const {
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    markUserMessageSent,
    waitForOpenCodeReady,
  } = dependencies;

  const service = createConversationsService({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    markUserMessageSent,
    waitForOpenCodeReady,
  });

  const registry = createOperationRegistry();

  app.post('/api/yuri/conversations', async (req, res) => {
    // Validate input
    const validation = validateConversationInput(req.body);
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        phase: 'validate',
        error: 'Invalid request',
        errors: validation.errors,
      });
    }

    const sanitized = validation.sanitized;
    const key = sanitized.messageID;
    const fp = fingerprint(sanitized);

    const sendResult = (result, httpStatus = null) => {
      if (res.destroyed || res.writableEnded) return;

      const status = httpStatus ?? (() => {
        if (result.ok) return 201;
        if (result.phase === 'create') {
          return (Number.isFinite(result.status) && result.status >= 400 && result.status < 500 && !(result.status === 408 || result.status === 429))
            ? 400 : 502;
        }
        if (result.phase === 'prompt') return result.ambiguous ? 502 : 400;
        if (result.phase === 'conflict') return 409;
        if (result.phase === 'unavailable') return 503;
        if (result.phase === 'internal') return 500;
        return 500;
      })();

      return res.status(status).json(result);
    };

    const { status, result, phase } = await registry.run(key, fp, () =>
      service.createAndPrompt({ sanitizedInput: sanitized }),
    );

    switch (status) {
      case 'conflict':
        return sendResult({ ok: false, phase: 'conflict', error: 'Conversation operation conflict' });
      case 'unavailable':
        return sendResult({ ok: false, phase: 'unavailable', error: 'Conversation service busy' });
      case 'dedup':
      case 'ran':
        return sendResult(result);
      default:
        return sendResult({ ok: false, phase: 'internal', error: 'Internal server error' });
    }
  });
};
