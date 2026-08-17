import { OpenCode } from '@opencode-ai/client';

// --- error classification ---

const isTransportError = (error) => {
  if (!error) return true;
  if (error.reason === 'Transport') return true;
  if (error.name === 'TypeError' || error.name === 'FetchError' || error.name === 'AbortError') return true;
  if (error.cause?.name === 'TypeError' || error.cause?.name === 'FetchError' || error.cause?.name === 'AbortError') return true;
  const code = error.cause?.code || error.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') return true;
  return false;
};

// v2 client throws raw data or ClientError; recover HTTP status when present.
const getHttpStatus = (error) => {
  const candidates = [error?.cause?.status, error?.status, error?.response?.status];
  for (const value of candidates) {
    if (Number.isFinite(value)) return value;
  }
  return undefined;
};

const classifyPromptFailure = (error) => {
  if (isTransportError(error)) {
    return { ambiguous: true, status: undefined };
  }
  const status = getHttpStatus(error);
  if (Number.isFinite(status)) {
    return { ambiguous: isRetryableHttpStatus(status), status };
  }
  // Declared v2 HTTP errors (400/401/404/409) throw JSON without a status field.
  return { ambiguous: false, status: 400 };
};

// Map sanitized parts onto the official v2 prompt body (text/files/agents).
const toV2PromptInput = (sanitizedInput, sessionID) => {
  const text = sanitizedInput.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const files = sanitizedInput.parts
    .filter((part) => part.type === 'file')
    .map((part) => ({
      uri: part.url,
      ...(part.filename ? { name: part.filename } : {}),
    }));
  const agents = sanitizedInput.parts
    .filter((part) => part.type === 'agent')
    .map((part) => ({ name: part.name }));

  return {
    sessionID,
    id: sanitizedInput.messageID,
    text,
    ...(files.length > 0 ? { files } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(sanitizedInput.metadata ? { metadata: sanitizedInput.metadata } : {}),
    delivery: 'steer',
  };
};

const isRetryableHttpStatus = (status) => {
  if (!Number.isFinite(status)) return true;
  return status === 408 || status === 429 || status >= 500;
};

const isAmbiguousPromptError = (_error, response) => {
  if (!response) return true;
  const status = response?.status;
  if (!Number.isFinite(status)) return true;
  return isRetryableHttpStatus(status);
};

// --- safe error messages (no paths/urls/secrets leaked to client) ---

const CLIENT_SAFE_ERRORS = {
  create: 'Failed to create session',
  prompt: 'Failed to submit prompt',
  internal: 'Internal server error',
};

const safeErrorMessage = (phase) =>
  CLIENT_SAFE_ERRORS[phase] || CLIENT_SAFE_ERRORS.internal;

// --- safe markUserMessageSent wrapper ---

const safeMark = (markUserMessageSent, sessionID, logger) => {
  if (typeof markUserMessageSent !== 'function' || !sessionID) return;
  try {
    markUserMessageSent(sessionID);
  } catch (err) {
    logger?.warn?.('[conversations] markUserMessageSent failed:', err?.message ?? err);
  }
};

// --- internal bounded timeout signals ---

const CREATE_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 45_000;
const READY_TIMEOUT_MS = 6_000;
const READY_POLL_MS = 75;

const timeoutSignal = (ms) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
};

// --- main service ---

export const createConversationsService = (deps) => {
  const {
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    markUserMessageSent,
    waitForOpenCodeReady,
    logger = console,
  } = deps;

  const ensureClient = async () => {
    if (typeof waitForOpenCodeReady === 'function') {
      const t = timeoutSignal(READY_TIMEOUT_MS);
      try {
        await waitForOpenCodeReady(READY_TIMEOUT_MS, READY_POLL_MS);
      } catch (_err) {
        logger.warn('[conversations] waitForOpenCodeReady failed');
        return { error: 'openCodeNotReady' };
      } finally {
        t.clear();
      }
    }

    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const authHeaders = getOpenCodeAuthHeaders();
    return OpenCode.make({ baseUrl, headers: authHeaders });
  };

  const createAndPrompt = async ({ sanitizedInput } = {}) => {
    const clientOrError = await ensureClient();
    if (clientOrError?.error) {
      return {
        ok: false,
        phase: 'create',
        error: safeErrorMessage('create'),
      };
    }
    const client = clientOrError;

    // Phase 1: create session (30s timeout)
    let session;
    const createT = timeoutSignal(CREATE_TIMEOUT_MS);
    try {
      session = await client.session.create({
        location: { directory: sanitizedInput.directory },
        ...(sanitizedInput.title ? { title: sanitizedInput.title } : {}),
        ...(sanitizedInput.agent ? { agent: sanitizedInput.agent } : {}),
        ...(sanitizedInput.model ? {
          model: {
            id: sanitizedInput.model.modelID,
            providerID: sanitizedInput.model.providerID,
            ...(sanitizedInput.variant ? { variant: sanitizedInput.variant } : {}),
          },
        } : {}),
      }, {
        signal: createT.signal,
      });
    } catch (error) {
      const status = getHttpStatus(error);
      if (Number.isFinite(status) && !isTransportError(error)) {
        logger.warn(`[conversations] session.create client error (${status})`);
        return {
          ok: false,
          phase: 'create',
          error: safeErrorMessage('create'),
          status,
        };
      }
      logger.warn('[conversations] session.create transport error');
      return {
        ok: false,
        phase: 'create',
        error: safeErrorMessage('create'),
      };
    } finally {
      createT.clear();
    }

    const sessionID = session?.id;
    if (!sessionID) {
      logger.warn('[conversations] session.create returned no session ID');
      return {
        ok: false,
        phase: 'create',
        error: safeErrorMessage('create'),
      };
    }

    // Phase 2: v2 prompt + delivery=steer (45s timeout). Host only orchestrates
    // create + first prompt; it does not cache message body as conversation content.
    let promptResult;
    const promptT = timeoutSignal(PROMPT_TIMEOUT_MS);
    try {
      promptResult = await client.session.prompt(toV2PromptInput(sanitizedInput, sessionID), {
        signal: promptT.signal,
      });
    } catch (error) {
      const { ambiguous, status } = classifyPromptFailure(error);
      logger.warn(`[conversations] prompt throw (ambiguous=${ambiguous})`);
      if (ambiguous) {
        safeMark(markUserMessageSent, sessionID, logger);
      }
      return {
        ok: false,
        phase: 'prompt',
        session,
        messageID: sanitizedInput.messageID,
        ambiguous,
        error: safeErrorMessage('prompt'),
        ...(Number.isFinite(status) ? { status } : {}),
      };
    } finally {
      promptT.clear();
    }

    // SDK result shape { data, error, response }
    // prompt success — return inbox item when present; never persist parts/text.
    safeMark(markUserMessageSent, sessionID, logger);

    const inbox = promptResult && typeof promptResult === 'object'
      ? promptResult
      : undefined;

    return {
      ok: true,
      session,
      messageID: sanitizedInput.messageID,
      ...(inbox && (inbox.id || inbox.type) ? { inbox } : {}),
    };
  };

  return {
    createAndPrompt,
  };
};
