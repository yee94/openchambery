import { OpenCode } from '@opencode/client';
import { buildLlmSessionMetadata } from '../session-metadata/system-session.js';

const LLM_AGENT_NAME = 'openchamber-llm';
const GENERATE_TIMEOUT_MS = 90_000;
/** Single attachment payload cap (decoded bytes). Composer UI allows larger drafts; gateway enforces this. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_FILE_CHARS = 100_000;
const TEXT_FILE_MIME = /^(text\/|application\/(json|javascript|xml|sql|yaml|x-yaml|toml))/i;

const positiveMs = (value, fallback) => (
  Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
);

/**
 * Agent frontmatter for official client agent permissions (action/resource/effect).
 * The final rule must be deny-all; assertLlmAgentDenyAll verifies that before prompt.
 */
const AGENT_MARKDOWN = `---
mode: primary
hidden: true
permissions:
  - action: "*"
    resource: "*"
    effect: deny
---

You generate responses for an application-owned assistant. Follow the supplied system instructions and response format.
The application executes its registered tools, including openchamber-tool JSON fences in your response, and supplies their results on the next request.
Emit the requested application tool call when an action requires one. Your native tool permissions describe this generator process; the application's supplied tool catalog describes the assistant's capabilities.
Report execution and failures from supplied tool results only.
Do not call native OpenCode tools, MCP tools, or skill tools. Native permissions are denied for this generator session.
`;

const failGenerate = (message, code = 'upstream_error') => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const clientErrorMessage = (error, fallback) => {
  if (typeof error?.message === 'string' && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
};

const isAbortLike = (error, signal) => (
  signal?.aborted
  || error?.name === 'AbortError'
  || error?.code === 'ABORT_ERR'
  || (typeof error?.message === 'string' && /aborted|This operation was aborted/i.test(error.message))
);

const rethrowIfAborted = (error, signal) => {
  if (!isAbortLike(error, signal)) return;
  if (error instanceof Error) throw error;
  const next = new Error(clientErrorMessage(error, 'aborted'));
  next.name = 'AbortError';
  throw next;
};

const assistantErrorDetail = (error) => {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message.trim()) return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return '';
};

const messageText = (message) => {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
};

const messageFileParts = (message) => {
  const fromParts = Array.isArray(message?.parts) ? message.parts : [];
  const fromContent = Array.isArray(message?.content) ? message.content : [];
  return [...fromParts, ...fromContent]
    .filter((part) => part?.type === 'file' && typeof part.mime === 'string' && typeof part.url === 'string')
    .map((part) => ({
      type: 'file',
      mime: part.mime,
      url: part.url,
      ...(typeof part.filename === 'string' && part.filename.trim() ? { filename: part.filename.trim() } : {}),
    }));
};

/**
 * Strict data-URL parse. Returns null when the URI is not a well-formed data URL.
 * Decoded size is checked against MAX_ATTACHMENT_BYTES.
 */
export function parseDataUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 5) return null;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (!meta || payload.length === 0) return null;
  const parts = meta.split(';');
  const mime = parts[0] && /^[\w.+-]+\/[\w.+-]+$/i.test(parts[0]) ? parts[0] : null;
  if (!mime) return null;
  const isBase64 = parts.some((part) => part.toLowerCase() === 'base64');
  let bytes;
  try {
    bytes = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch {
    return null;
  }
  // Reject corrupt base64 that decodes to empty while payload was non-empty.
  if (isBase64 && bytes.length === 0 && payload.replace(/\s/g, '').length > 0) return null;
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    const error = new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit`);
    error.code = 'validation_error';
    throw error;
  }
  return { mime, bytes, isBase64, byteLength: bytes.length };
}

const decodeDataUrlText = (url, mime) => {
  if (!TEXT_FILE_MIME.test(mime)) return null;
  let parsed;
  try {
    parsed = parseDataUrl(url);
  } catch (error) {
    if (error?.code === 'validation_error') throw error;
    return null;
  }
  if (!parsed) return null;
  const text = parsed.bytes.toString('utf8');
  return text.length > MAX_INLINE_FILE_CHARS ? `${text.slice(0, MAX_INLINE_FILE_CHARS)}\n…` : text;
};

const describeContactFilePart = (part) => {
  const name = part.filename || 'attachment';
  const mime = part.mime || 'application/octet-stream';
  if (typeof mime === 'string' && mime.startsWith('image/')) return `[image: ${name} (${mime})]`;
  const decoded = decodeDataUrlText(part.url, mime);
  if (decoded != null) return `[file: ${name} (${mime})]\n${decoded}`;
  return `[file: ${name} (${mime})]`;
};

/**
 * Validate every file part URL before generate. Non-data URLs are rejected
 * (gateway only accepts contact data-URL attachments).
 */
export function assertValidAttachmentParts(files) {
  for (const part of files) {
    if (!part || typeof part.url !== 'string') {
      failGenerate('Attachment is missing a data URL', 'validation_error');
    }
    if (!part.url.startsWith('data:')) {
      failGenerate('Attachment URL must be a data URL', 'validation_error');
    }
    const parsed = parseDataUrl(part.url);
    if (!parsed) {
      failGenerate('Attachment data URL is malformed', 'validation_error');
    }
  }
}

const flattenMessages = (messages) => {
  const system = [];
  const turns = [];
  const files = [];
  for (const message of messages) {
    if (!message) continue;
    const text = messageText(message);
    const fileParts = message.role === 'user' ? messageFileParts(message) : [];
    if (message.role === 'system') {
      if (text.trim()) system.push(text);
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const body = [text, ...fileParts.map(describeContactFilePart)].filter((item) => String(item || '').trim()).join('\n');
    if (!body && fileParts.length === 0) continue;
    turns.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${body || '[attachment]'}`);
    files.push(...fileParts);
  }
  return {
    system: system.join('\n\n').trim(),
    prompt: turns.join('\n\n').trim(),
    files,
  };
};

/** Image bytes only when the catalog model is vision-capable. */
const filesForPrompt = (files, forwardImageParts) => {
  if (forwardImageParts) return files;
  return files.filter((part) => !String(part?.mime || '').startsWith('image/'));
};

const imageFilesForSession = (files, forwardImageParts) => {
  if (!forwardImageParts) return [];
  return files.filter((part) => String(part?.mime || '').startsWith('image/'));
};

const modelRef = (providerID, modelID, variant) => ({
  id: modelID,
  providerID,
  ...(variant ? { variant } : {}),
});

const eventPayload = (event) => event?.payload?.payload ?? event?.payload ?? event;

const eventDeltaData = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.data && typeof payload.data === 'object') return payload.data;
  if (payload.properties && typeof payload.properties === 'object') return payload.properties;
  return null;
};

/**
 * Forward real OpenCode `session.text.delta` tokens for one throwaway session.
 * Consumes data.sessionID / assistantMessageID / ordinal / delta.
 * Returns unsubscribe, or null when deltas cannot be observed.
 *
 * @param {{ globalEventHub?: { subscribeEvent?: Function } | null, sessionID: string, onTextDelta?: ((text: string) => void) | null }} args
 * @returns {(() => void) | null}
 */
export function subscribeThrowawayTextDeltas({ globalEventHub, sessionID, onTextDelta }) {
  if (typeof onTextDelta !== 'function') return null;
  if (typeof sessionID !== 'string' || !sessionID) return null;
  if (typeof globalEventHub?.subscribeEvent !== 'function') return null;

  let assistantMessageID = null;
  let lastOrdinal = -1;

  const unsubscribe = globalEventHub.subscribeEvent((event) => {
    const payload = eventPayload(event);
    if (payload?.type !== 'session.text.delta') return;
    const data = eventDeltaData(payload);
    if (!data) return;
    if (data.sessionID !== sessionID) return;
    if (typeof data.delta !== 'string' || data.delta.length === 0) return;

    const messageID = typeof data.assistantMessageID === 'string' && data.assistantMessageID
      ? data.assistantMessageID
      : null;
    if (assistantMessageID) {
      if (messageID && messageID !== assistantMessageID) return;
    } else if (messageID) {
      assistantMessageID = messageID;
    }

    if (typeof data.ordinal === 'number' && Number.isFinite(data.ordinal)) {
      if (data.ordinal <= lastOrdinal) return;
      lastOrdinal = data.ordinal;
    }

    try {
      onTextDelta(data.delta);
    } catch {
      // Caller callback failures must not abort generate or leave the hub broken.
    }
  });

  return typeof unsubscribe === 'function' ? unsubscribe : null;
}

/**
 * Verify the openchamber-llm agent ends with deny-all permissions.
 * Title alone is never treated as isolation. Failure must happen before prompt.
 */
export async function assertLlmAgentDenyAll({ client, location, signal }) {
  let result;
  try {
    result = await client.agent.get({
      agentID: LLM_AGENT_NAME,
      ...(location ? { location } : {}),
    }, { signal });
  } catch (error) {
    failGenerate(
      `OpenCode LLM agent is unavailable (${clientErrorMessage(error, 'agent.get failed')}); attachment generation blocked`,
      'llm_attachment_generation_unavailable',
    );
  }
  const permissions = result?.data?.permissions;
  if (!Array.isArray(permissions) || permissions.length === 0) {
    failGenerate(
      'OpenCode LLM agent permissions are missing; attachment generation blocked',
      'llm_attachment_generation_unavailable',
    );
  }
  const last = permissions[permissions.length - 1];
  if (
    !last
    || last.action !== '*'
    || last.resource !== '*'
    || last.effect !== 'deny'
  ) {
    failGenerate(
      'OpenCode LLM agent final permission is not deny-all; attachment generation blocked',
      'llm_attachment_generation_unavailable',
    );
  }
  return result.data;
}

const assistantTextFromMessages = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  for (const message of messages) {
    // message.list order:desc — first assistant is the newest.
    const role = message?.type ?? message?.role ?? message?.info?.role;
    if (role !== 'assistant') continue;
    const error = message?.error ?? message?.info?.error;
    if (error) {
      const detail = assistantErrorDetail(error);
      failGenerate(detail || 'OpenCode assistant error');
    }
    const finish = message?.finish ?? message?.info?.finish;
    if (finish === 'error') {
      failGenerate(assistantErrorDetail(message?.error) || 'OpenCode assistant finish=error');
    }
    const content = Array.isArray(message?.content)
      ? message.content
      : Array.isArray(message?.parts)
        ? message.parts
        : [];
    const text = content
      .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
    return text;
  }
  return '';
};

const makeClient = ({ baseUrl, headers, clientFactory }) => {
  if (typeof clientFactory === 'function') return clientFactory();
  return OpenCode.make({ baseUrl, headers });
};

async function generateViaTextApi({
  client,
  location,
  providerID,
  modelID,
  variant,
  prompt,
  signal,
}) {
  let result;
  try {
    result = await client.generate.text({
      ...(location ? { location } : {}),
      prompt,
      model: modelRef(providerID, modelID, variant),
    }, { signal });
  } catch (error) {
    rethrowIfAborted(error, signal);
    failGenerate(clientErrorMessage(error, 'OpenCode generate.text failed'));
  }
  const text = typeof result?.text === 'string'
    ? result.text.trim()
    : typeof result?.data?.text === 'string'
      ? result.data.text.trim()
      : '';
  if (!text) failGenerate('OpenCode generate.text returned no text');
  return { text, source: 'generate.text' };
}

async function generateViaAttachmentSession({
  client,
  workingDirectory,
  providerID,
  modelID,
  variant,
  system,
  prompt,
  imageFiles,
  signal,
  onTextDelta,
  globalEventHub,
  persistSessionMetadata,
  onSystemSessionPersisted,
}) {
  const location = { directory: workingDirectory };

  // Permission isolation must be verified before any prompt. Never use title as isolation.
  await assertLlmAgentDenyAll({ client, location, signal });

  let sessionID = null;
  let unsubscribeDeltas = null;
  try {
    let created;
    const isolationMetadata = buildLlmSessionMetadata();
    try {
      created = await client.session.create({
        title: '[openchamber-llm] generate',
        agent: LLM_AGENT_NAME,
        model: modelRef(providerID, modelID, variant),
        location,
        metadata: isolationMetadata,
      }, { signal });
    } catch (error) {
      // Temp workspace invisible to OpenCode must fail explicitly.
      failGenerate(
        `OpenCode LLM session create failed (${clientErrorMessage(error, 'create failed')})`,
        'llm_attachment_generation_unavailable',
      );
    }
    sessionID = created?.id ?? created?.data?.id;
    if (!sessionID) {
      failGenerate('OpenCode LLM session create returned no id', 'llm_attachment_generation_unavailable');
    }
    if (typeof persistSessionMetadata === 'function') {
      try {
        await persistSessionMetadata(sessionID, isolationMetadata);
        onSystemSessionPersisted?.({
          sessionID,
          directory: workingDirectory,
          metadata: isolationMetadata,
        });
      } catch (error) {
        console.warn('[llm] failed to persist system session metadata:', error?.message || error);
      }
    }

    if (system) {
      try {
        await client.session.instructions.entry.put({
          sessionID,
          key: 'system',
          value: system,
        }, { signal });
      } catch (error) {
        failGenerate(clientErrorMessage(error, 'instructions.entry.put failed'));
      }
    }

    unsubscribeDeltas = subscribeThrowawayTextDeltas({
      globalEventHub,
      sessionID,
      onTextDelta,
    });

    const files = imageFiles.map((part) => ({
      uri: part.url,
      ...(part.filename ? { name: part.filename } : {}),
    }));

    try {
      await client.session.prompt({
        sessionID,
        text: prompt || '[attachment]',
        ...(files.length > 0 ? { files } : {}),
        delivery: 'steer',
      }, { signal });
    } catch (error) {
      rethrowIfAborted(error, signal);
      failGenerate(clientErrorMessage(error, 'session.prompt failed'));
    }

    try {
      await client.session.wait({ sessionID }, { signal });
    } catch (error) {
      rethrowIfAborted(error, signal);
      failGenerate(clientErrorMessage(error, 'session.wait failed'));
    }

    let listed;
    try {
      listed = await client.message.list({
        sessionID,
        limit: 20,
        order: 'desc',
      }, { signal });
    } catch (error) {
      rethrowIfAborted(error, signal);
      failGenerate(clientErrorMessage(error, 'message.list failed'));
    }

    const messages = Array.isArray(listed?.data) ? listed.data : [];
    const text = assistantTextFromMessages(messages);
    if (!text.trim()) {
      failGenerate('OpenCode LLM generator returned no assistant text');
    }
    return { text: text.trim(), source: 'attachment-session' };
  } finally {
    try {
      unsubscribeDeltas?.();
    } catch {
      // Unsubscribe must not mask generate errors or block session remove.
    }
    unsubscribeDeltas = null;
    if (sessionID) {
      if (signal?.aborted) {
        try {
          await client.session.interrupt({ sessionID, continue: false });
        } catch {
          // Best-effort interrupt on timeout/abort.
        }
      }
      try {
        await client.session.remove({ sessionID });
      } catch (error) {
        console.warn('[llm] failed to remove throwaway OpenCode session:', error?.message || error);
      }
    }
  }
}

/**
 * Generate assistant text through OpenCode's connected providers via
 * `@opencode/client`.
 *
 * - Pure text: `generate.text` (no session).
 * - Vision image attachments: dedicated temp session after agent deny-all verify.
 * - Non-vision: keep `[image: …]` descriptions; never forward image bytes.
 *
 * Optional internal streaming: `onTextDelta` + `globalEventHub` forwards real
 * `session.text.delta` tokens on the attachment-session path only.
 * `generate.text` cannot emit live deltas (no fake typewriter).
 *
 * Optional `signal` from the contact continuation is combined with the generator
 * deadline. Cancellation still runs throwaway-session cleanup.
 */
export async function generateOpenCodeText({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  providerID,
  modelID,
  messages,
  variant,
  clientFactory,
  ensureTempDirectory,
  forwardImageParts = false,
  onTextDelta = null,
  globalEventHub = null,
  persistSessionMetadata = null,
  onSystemSessionPersisted = null,
  signal: parentSignal = null,
  timeoutMs = GENERATE_TIMEOUT_MS,
}) {
  parentSignal?.throwIfAborted?.();
  if (!providerID || !modelID) {
    const error = new Error('providerID and modelID are required');
    error.code = 'validation_error';
    throw error;
  }
  const flattened = flattenMessages(messages);
  const allFiles = flattened.files;
  assertValidAttachmentParts(allFiles);

  const imageFiles = imageFilesForSession(allFiles, forwardImageParts);
  // Non-image files stay as prompt descriptions (and inlined text when possible).
  if (!flattened.prompt && imageFiles.length === 0 && allFiles.length === 0) {
    const error = new Error('messages must include a user turn');
    error.code = 'validation_error';
    throw error;
  }

  const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
  const headers = getOpenCodeAuthHeaders() || {};
  const client = makeClient({ baseUrl, headers, clientFactory });

  const controller = new AbortController();
  const deadlineMs = positiveMs(timeoutMs, GENERATE_TIMEOUT_MS);
  const requestSignal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  const timeout = setTimeout(() => {
    controller.abort(new Error(`OpenCode LLM generate timed out after ${deadlineMs}ms`));
  }, deadlineMs);
  timeout.unref?.();

  try {
    if (imageFiles.length > 0) {
      if (typeof ensureTempDirectory !== 'function') {
        failGenerate(
          'LLM temp directory is required for attachment generation',
          'llm_attachment_generation_unavailable',
        );
      }
      let workingDirectory;
      try {
        workingDirectory = await ensureTempDirectory({
          agentName: LLM_AGENT_NAME,
          agentMarkdown: AGENT_MARKDOWN,
        });
      } catch (error) {
        failGenerate(
          `LLM temp directory failed (${clientErrorMessage(error, 'ensure failed')})`,
          'llm_attachment_generation_unavailable',
        );
      }
      if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) {
        failGenerate(
          'LLM temp directory is empty; attachment generation blocked',
          'llm_attachment_generation_unavailable',
        );
      }
      return await generateViaAttachmentSession({
        client,
        workingDirectory: workingDirectory.trim(),
        providerID,
        modelID,
        variant,
        system: flattened.system,
        prompt: flattened.prompt,
        imageFiles,
        signal: requestSignal,
        onTextDelta,
        globalEventHub,
        persistSessionMetadata,
        onSystemSessionPersisted,
      });
    }

    // Text path: no session. System prompt is prepended into the single prompt string.
    const prompt = [flattened.system, flattened.prompt].filter((part) => String(part || '').trim()).join('\n\n');
    return await generateViaTextApi({
      client,
      providerID,
      modelID,
      variant,
      prompt,
      signal: requestSignal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export const _test = {
  flattenMessages,
  filesForPrompt,
  imageFilesForSession,
  describeContactFilePart,
  assistantTextFromMessages,
  eventPayload,
  eventDeltaData,
  subscribeThrowawayTextDeltas,
  assertLlmAgentDenyAll,
  parseDataUrl,
  assertValidAttachmentParts,
  LLM_AGENT_NAME,
  AGENT_MARKDOWN,
  MAX_ATTACHMENT_BYTES,
  GENERATE_TIMEOUT_MS,
};
