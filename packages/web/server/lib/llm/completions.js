import { isConnectedModel, loadConnectedCatalog, parseModelRef } from './catalog.js';
import { generateOpenCodeText, parseDataUrl, MAX_ATTACHMENT_BYTES } from './generate.js';

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
  const url = part.url.trim();
  if (!url.startsWith('data:')) {
    throw new LlmError('validation_error', 400, 'file part url must be a data URL');
  }
  let parsed;
  try {
    parsed = parseDataUrl(url);
  } catch (error) {
    if (error?.code === 'validation_error') {
      throw new LlmError('validation_error', 400, error.message || 'attachment too large');
    }
    throw error;
  }
  if (!parsed) {
    throw new LlmError('validation_error', 400, 'file part data URL is malformed');
  }
  if (parsed.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new LlmError('validation_error', 400, `Attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit`);
  }
  return {
    type: 'file',
    mime: part.mime.trim(),
    url,
    ...(typeof part.filename === 'string' && part.filename.trim() ? { filename: part.filename.trim() } : {}),
  };
};

const normalizeMessages = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LlmError('validation_error', 400, 'messages is required');
  }
  return messages.map((message) => {
    if (!isRecord(message) || (typeof message.content !== 'string' && !(message.role === 'assistant' && message.content == null && Array.isArray(message.tool_calls)))) {
      throw new LlmError('validation_error', 400, 'each message needs role and string content');
    }
    const role = message.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
      throw new LlmError('validation_error', 400, 'message role must be system, user, assistant, or tool');
    }
    const parts = Array.isArray(message.parts)
      ? message.parts.map(normalizeCompletionFilePart).filter(Boolean)
      : [];
    const normalized = { role, content: message.content ?? '' };
    if (role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id || typeof message.name !== 'string' || !message.name) throw new LlmError('validation_error', 400, 'tool result needs name and tool_call_id');
      normalized.tool_call_id = message.tool_call_id;
      normalized.name = message.name;
    }
    if (role === 'assistant' && message.tool_calls != null) {
      if (!Array.isArray(message.tool_calls)) throw new LlmError('validation_error', 400, 'tool_calls must be an array');
      normalized.tool_calls = message.tool_calls.map(call => {
        if (typeof call?.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || !call.function.name || typeof call.function?.arguments !== 'string') throw new LlmError('validation_error', 400, 'Invalid assistant tool call');
        try { JSON.parse(call.function.arguments); } catch { throw new LlmError('validation_error', 400, 'Invalid tool arguments'); }
        return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
      });
    }
    return parts.length > 0 ? { ...normalized, parts } : normalized;
  });
};

const completionId = () => `chatcmpl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export function toOpenAICompletion({ id, model, text, toolCalls = [], usage, created = Math.floor(Date.now() / 1000) }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) },
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: usage?.inputTokens ?? 0, completion_tokens: usage?.outputTokens ?? 0, total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0), prompt_tokens_details: { cached_tokens: usage?.cacheReadInputTokens ?? 0 } },
  };
};

/**
 * OpenAI-shaped completions against OpenCode's already-connected providers.
 *
 * Public HTTP stays non-streaming (`stream: true` → validation_error).
 * In-process callers (Assistant contact harness) may pass `onTextDelta` and
 * `globalEventHub`. The one-shot bridge does not fabricate token callbacks.
 */
export async function createChatCompletion({
  body,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  clientFactory,
  loadCatalog = loadConnectedCatalog,
  generateText = generateOpenCodeText,
  onTextDelta = null,
  globalEventHub = null,
  persistSessionMetadata = null,
  onSystemSessionPersisted = null,
  signal = null,
  timeoutMs,
  retryEmptyTextUntilCancelled = false,
  cacheKey,
  maxOutputTokens,
  validateToolCalls = true,
}) {
  signal?.throwIfAborted();
  if (!isRecord(body)) throw new LlmError('validation_error', 400, 'JSON body is required');
  // The external inference RPC returns a full turn. This HTTP gateway
  // does not token-stream. Do not emit fake SSE after the fact.
  // In-process onTextDelta (optional) is a separate internal callback path.
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
  if (body.variant != null && typeof body.variant !== 'string') {
    throw new LlmError('validation_error', 400, 'variant must be a string or null');
  }
  const variant = body.variant?.trim() || undefined;
  if (body.tools != null && !Array.isArray(body.tools)) throw new LlmError('validation_error', 400, 'tools must be an array');
  const tools = (body.tools ?? []).map(tool => {
    if (tool?.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.name || !isRecord(tool.function.parameters)) throw new LlmError('validation_error', 400, 'Invalid tool schema');
    return { name: tool.function.name, description: tool.function.description || tool.function.name, inputSchema: tool.function.parameters };
  });

  const client = clientFactory?.() ?? null;
  const catalog = await loadCatalog(client ?? {
    provider: { list: async () => { throw new Error('no client'); } },
    model: { list: async () => { throw new Error('no client'); } },
  });
  signal?.throwIfAborted();
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
      ...(variant ? { variant } : {}),
      messages,
      clientFactory,
      forwardImageParts: Boolean(catalog.models.find((entry) => (
        entry.providerID === resolved.providerID && entry.modelID === resolved.modelID
      ))?.acceptsImages),
      onTextDelta,
      globalEventHub,
      persistSessionMetadata,
      onSystemSessionPersisted,
      signal,
      timeoutMs,
      retryEmptyTextUntilCancelled,
      tools,
      ...(cacheKey ? { cacheKey } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    });
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error?.code === 'validation_error') {
      throw new LlmError('validation_error', 400, error.message || 'validation_error');
    }
    if (error?.code === 'llm_attachment_generation_unavailable') {
      throw new LlmError(
        'llm_attachment_generation_unavailable',
        502,
        typeof error?.message === 'string' && error.message.trim()
          ? error.message
          : 'LLM attachment generation is unavailable',
      );
    }
    const failure = new LlmError(
      'upstream_error',
      502,
      typeof error?.message === 'string' && error.message.trim()
        ? error.message
        : 'OpenCode generate failed',
    );
    if (error?.type === 'generation_failed' && isRecord(error.data)) {
      failure.providerFailure = error.data;
    }
    throw failure;
  }
  const text = typeof generated?.text === 'string' ? generated.text.trim() : '';
  if (!text && !generated?.toolCalls?.length) throw new LlmError('upstream_error', 502, 'OpenCode returned no assistant text');
  if (validateToolCalls && generated.toolCalls?.some(call => !tools.some(tool => tool.name === call.name))) throw new LlmError('upstream_error', 502, 'Model returned an unavailable tool');

  const model = `${resolved.providerID}/${resolved.modelID}`;
  return {
    completion: toOpenAICompletion({ id: completionId(), model, text, toolCalls: generated.toolCalls, usage: generated.usage }),
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: generated.source,
  };
}
