import { isConnectedModel, loadConnectedCatalog, parseModelRef } from './catalog.js';
import { generateOpenCodeText } from './generate.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class LlmError extends Error {
  constructor(code, statusCode, message) {
    super(message || code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const normalizeCompletionFilePart = (part) => {
  if (!isRecord(part) || part.type !== 'file') return null;
  if (typeof part.mime !== 'string' || !part.mime.trim()) return null;
  if (typeof part.url !== 'string' || !part.url.trim()) return null;
  return {
    type: 'file',
    mime: part.mime.trim(),
    url: part.url.trim(),
    ...(typeof part.filename === 'string' && part.filename.trim() ? { filename: part.filename.trim() } : {}),
  };
};

const normalizeMessages = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LlmError('validation_error', 400, 'messages is required');
  }
  return messages.map((message) => {
    if (!isRecord(message) || typeof message.content !== 'string') {
      throw new LlmError('validation_error', 400, 'each message needs role and string content');
    }
    const role = message.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new LlmError('validation_error', 400, 'message role must be system, user, or assistant');
    }
    const parts = Array.isArray(message.parts)
      ? message.parts.map(normalizeCompletionFilePart).filter(Boolean)
      : [];
    return parts.length > 0 ? { role, content: message.content, parts } : { role, content: message.content };
  });
};

const completionId = () => `chatcmpl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export function toOpenAICompletion({ id, model, text, created = Math.floor(Date.now() / 1000) }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * OpenAI-shaped completions against OpenCode's already-connected providers.
 */
export async function createChatCompletion({
  body,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  clientFactory,
  loadCatalog = loadConnectedCatalog,
  generateText = generateOpenCodeText,
  ensureTempDirectory,
  fetchImpl,
}) {
  if (!isRecord(body)) throw new LlmError('validation_error', 400, 'JSON body is required');
  // Bundled OpenCode 1.18.4 generate is a full-turn JSON reply (sessionless
  // generate or throwaway session.promptAsync). This gateway does not token-stream.
  // Do not emit fake SSE after the fact.
  if (body.stream === true) {
    throw new LlmError(
      'validation_error',
      400,
      'This gateway is non-streaming; omit stream or set stream:false',
    );
  }
  const resolved = parseModelRef(body.model, body.providerID, body.modelID);
  if (!resolved) throw new LlmError('validation_error', 400, 'model or providerID/modelID is required');
  const messages = normalizeMessages(body.messages);

  const client = clientFactory?.() ?? null;
  const catalog = await loadCatalog(client ?? {
    provider: { list: async () => ({ error: { status: 500 } }) },
    config: { providers: async () => ({ error: { status: 500 } }) },
  });
  if (!isConnectedModel(catalog, resolved.providerID, resolved.modelID)) {
    throw new LlmError(
      'no_provider',
      400,
      `No connected OpenCode provider for ${resolved.providerID}/${resolved.modelID}`,
    );
  }

  let generated;
  try {
    generated = await generateText({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      providerID: resolved.providerID,
      modelID: resolved.modelID,
      messages,
      fetchImpl,
      clientFactory,
      ensureTempDirectory,
      forwardImageParts: Boolean(catalog.models.find((entry) => (
        entry.providerID === resolved.providerID && entry.modelID === resolved.modelID
      ))?.acceptsImages),
    });
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error?.code === 'validation_error') {
      throw new LlmError('validation_error', 400, error.message || 'validation_error');
    }
    throw new LlmError(
      'upstream_error',
      502,
      typeof error?.message === 'string' && error.message.trim()
        ? error.message
        : 'OpenCode generate failed',
    );
  }
  const text = typeof generated?.text === 'string' ? generated.text.trim() : '';
  if (!text) throw new LlmError('upstream_error', 502, 'OpenCode returned no assistant text');

  const model = `${resolved.providerID}/${resolved.modelID}`;
  return {
    completion: toOpenAICompletion({ id: completionId(), model, text }),
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: generated.source,
  };
}
