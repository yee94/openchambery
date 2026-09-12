import { createOpencodeClient } from '@opencode-ai/sdk/v2';

const LLM_AGENT_NAME = 'openchamber-llm';
const GENERATE_TIMEOUT_MS = 90_000;
const SETTLE_POLL_MS = 250;
const INCOMPLETE_ASSISTANT_SETTLE_PROBES = 2;
const EMPTY_IDLE_PROBES = 5;

const positiveMs = (value, fallback) => (
  Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
);

/**
 * Session-level deny-all. OpenCode 1.18 session.create serializes this
 * PermissionRuleset shape (permission/pattern/action). Confirmed on local
 * 1.18.23/1.18.29: create returns the same rule on the session object.
 */
export const LLM_SESSION_DENY_PERMISSION = Object.freeze([
  Object.freeze({ permission: '*', pattern: '*', action: 'deny' }),
]);

/**
 * Agent frontmatter for OpenCode 1.18. Runtime /agent metadata uses
 * permission:[{permission,pattern,action}]. Markdown config accepts the
 * PermissionActionConfig map (`"*": deny`) / scalar `deny` / tools:"*":false —
 * not the legacy action/resource/effect list (that loads but does not add
 * a terminal * deny, so build-like allows and skill guidance stay visible).
 */
const AGENT_MARKDOWN = `---
mode: primary
hidden: true
permission:
  "*": deny
---

You generate responses for an application-owned assistant. Follow the supplied system instructions and response format.
The application executes its registered tools, including openchamber-tool JSON fences in your response, and supplies their results on the next request.
Emit the requested application tool call when an action requires one. Your native tool permissions describe this generator process; the application's supplied tool catalog describes the assistant's capabilities.
Report execution and failures from supplied tool results only.
Do not call native OpenCode tools, MCP tools, or skill tools. Native permissions are denied for this generator session.
`;

const isMissing = (result) =>
  result?.error?.status === 404
  || result?.error?.statusCode === 404
  || result?.error?.code === 'not_found'
  || result?.status === 404;

const promptAdmitted = (result) =>
  !result?.error
  && (result?.response?.status === 204
    || result?.status === 204
    || result?.data !== undefined
    || result?.response?.ok === true);

const sdkErrorMessage = (result, fallback) => {
  const status = result?.error?.status ?? result?.error?.statusCode ?? result?.status;
  const message = result?.error?.message || result?.error?.data?.message || fallback;
  return status ? `${message} (${status})` : message;
};

const failGenerate = (message) => {
  const error = new Error(message);
  error.code = 'upstream_error';
  throw error;
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    return;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener?.('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

const readMessageInfo = (message) => {
  if (!message || typeof message !== 'object') return null;
  if (message.info && typeof message.info === 'object') return message.info;
  return message;
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

const assistantTextFromPrompt = (data) => {
  const parts = Array.isArray(data?.parts) ? data.parts : Array.isArray(data?.data?.parts) ? data.data.parts : [];
  const text = parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  if (text.trim()) return text;
  const info = data?.info ?? data?.data?.info;
  if (info?.error) {
    const detail = assistantErrorDetail(info.error);
    if (detail) failGenerate(detail);
  }
  return '';
};

const assistantTextFromMessages = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const info = readMessageInfo(message);
    if (info?.role !== 'assistant') continue;
    if (info.error) {
      const detail = assistantErrorDetail(info.error);
      failGenerate(detail || 'OpenCode assistant error');
    }
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    return parts
      .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
};

const deniedTools = (ids) => {
  const tools = Object.create(null);
  for (const id of ids) {
    if (typeof id === 'string' && id.trim()) tools[id.trim()] = false;
  }
  return tools;
};

const waitForIdleAssistant = async ({
  client,
  sessionID,
  directory,
  signal,
  onProgress = null,
  settlePollMs = SETTLE_POLL_MS,
}) => {
  let incompleteAssistantProbes = 0;
  let emptyIdleProbes = 0;
  const pollMs = positiveMs(settlePollMs, SETTLE_POLL_MS);

  for (;;) {
    signal?.throwIfAborted?.();

    let sessionBusy = false;
    try {
      const statusResult = await client.session.status({ directory }, { signal });
      if (!statusResult?.error && statusResult?.data && typeof statusResult.data === 'object') {
        const statusValue = statusResult.data[sessionID];
        const type = statusValue?.type ?? statusValue?.status;
        sessionBusy = type === 'busy' || type === 'retry';
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }

    if (sessionBusy) {
      incompleteAssistantProbes = 0;
      emptyIdleProbes = 0;
      onProgress?.();
      await sleep(pollMs, signal);
      continue;
    }

    try {
      const messagesResult = await client.session.messages({
        sessionID,
        directory,
        limit: 20,
      }, { signal });
      if (messagesResult?.error) {
        // Deterministic upstream failures (e.g. 400) must not look like "still settling".
        failGenerate(`OpenCode LLM session.messages failed: ${sdkErrorMessage(messagesResult, 'messages failed')}`);
      }
      if (Array.isArray(messagesResult?.data)) {
        const lastInfo = readMessageInfo(messagesResult.data.at(-1));
        if (lastInfo?.role === 'assistant') {
          emptyIdleProbes = 0;
          if (lastInfo.error) {
            const detail = assistantErrorDetail(lastInfo.error);
            failGenerate(detail || 'OpenCode assistant error');
          }
          if (lastInfo.time?.completed) {
            return messagesResult.data;
          }
          incompleteAssistantProbes += 1;
          onProgress?.();
          if (incompleteAssistantProbes >= INCOMPLETE_ASSISTANT_SETTLE_PROBES) {
            return messagesResult.data;
          }
        } else {
          incompleteAssistantProbes = 0;
          emptyIdleProbes += 1;
          if (emptyIdleProbes >= EMPTY_IDLE_PROBES && lastInfo?.role === 'user') {
            failGenerate('OpenCode LLM generator ended without assistant text');
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.code === 'upstream_error') throw error;
    }

    await sleep(pollMs, signal);
  }
};

const isJsonContentType = (response) => /json/i.test(response?.headers?.get?.('content-type') || '');

const looksLikeJsonObject = (text) => {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.startsWith('<')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
};

/**
 * Detect a sessionless generate endpoint on the running OpenCode.
 * Bundled 1.18.4 does not expose POST /generate; keep the probe so a later
 * OpenCode that does can be used without changing the public completions API.
 *
 * SPA / OpenCode HTML often answers 200 text/html `<!doctype html>` for
 * unknown paths. That is not generate — only JSON (Content-Type or body)
 * counts as available.
 */
export async function detectSessionlessGenerate({ fetchImpl, baseUrl, headers }) {
  const clientShape = typeof arguments[0]?.client?.generate === 'function'
    || typeof arguments[0]?.client?.v2?.generate === 'function';
  if (clientShape) {
    return { available: true, mode: 'sdk' };
  }
  const root = String(baseUrl || '').replace(/\/$/, '');
  const candidates = [`${root}/generate`, `${root}/api/generate`];
  for (const url of candidates) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify({ probe: true }),
        signal: AbortSignal.timeout(4_000),
      });
      if (response.status === 404 || response.status === 405) continue;
      const body = await response.text().catch(() => '');
      if (isJsonContentType(response) || looksLikeJsonObject(body)) {
        return { available: true, mode: 'http', url };
      }
    } catch {
      // Probe failure is not a generate capability.
    }
  }
  return { available: false, mode: 'throwaway-session' };
}

const TEXT_FILE_MIME = /^(text\/|application\/(json|javascript|xml|sql|yaml|x-yaml|toml))/i;
const MAX_INLINE_FILE_CHARS = 100_000;

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

const decodeDataUrlText = (url, mime) => {
  if (!TEXT_FILE_MIME.test(mime) || typeof url !== 'string' || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  try {
    const bytes = meta.includes('base64')
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    const text = bytes.toString('utf8');
    return text.length > MAX_INLINE_FILE_CHARS ? `${text.slice(0, MAX_INLINE_FILE_CHARS)}\n…` : text;
  } catch {
    return null;
  }
};

const describeContactFilePart = (part) => {
  const name = part.filename || 'attachment';
  const mime = part.mime || 'application/octet-stream';
  if (typeof mime === 'string' && mime.startsWith('image/')) return `[image: ${name} (${mime})]`;
  const decoded = decodeDataUrlText(part.url, mime);
  if (decoded != null) return `[file: ${name} (${mime})]\n${decoded}`;
  return `[file: ${name} (${mime})]`;
};

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

const filesForPrompt = (files, forwardImageParts) => {
  if (forwardImageParts) return files;
  return files.filter((part) => !String(part?.mime || '').startsWith('image/'));
};

async function generateViaSessionless({ fetchImpl, url, headers, providerID, modelID, messages, signal }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify({
      model: { providerID, modelID },
      messages,
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    failGenerate(`OpenCode generate failed (${response.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const payload = await response.json();
  const text = typeof payload?.text === 'string'
    ? payload.text
    : typeof payload?.message === 'string'
      ? payload.message
      : '';
  if (!text.trim()) failGenerate('OpenCode generate returned no text');
  return { text: text.trim(), source: 'generate' };
}

const eventPayload = (event) => event?.payload?.payload ?? event?.payload ?? event;

const eventDeltaProperties = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.properties && typeof payload.properties === 'object') return payload.properties;
  if (payload.data && typeof payload.data === 'object') return payload.data;
  return null;
};

/**
 * Forward real OpenCode `message.part.delta` text tokens for one throwaway
 * session. Returns an unsubscribe fn, or null when deltas cannot be observed
 * (no callback, no hub, or hub without subscribeEvent). Never fabricates
 * typewriter chunks from a completed string.
 *
 * @param {{ globalEventHub?: { subscribeEvent?: Function } | null, sessionID: string, onTextDelta?: ((text: string) => void) | null }} args
 * @returns {(() => void) | null}
 */
export function subscribeThrowawayTextDeltas({ globalEventHub, sessionID, onTextDelta }) {
  if (typeof onTextDelta !== 'function') return null;
  if (typeof sessionID !== 'string' || !sessionID) return null;
  if (typeof globalEventHub?.subscribeEvent !== 'function') return null;

  // Lock to the first assistant messageID seen for this throwaway session so
  // concurrent sessions on the shared hub cannot leak tokens into this generate.
  let assistantMessageID = null;

  const unsubscribe = globalEventHub.subscribeEvent((event) => {
    const payload = eventPayload(event);
    if (payload?.type !== 'message.part.delta') return;
    const props = eventDeltaProperties(payload);
    if (!props) return;
    if (props.sessionID !== sessionID) return;
    // Text field only — reasoning/other fields stay out of completion tokens.
    if (typeof props.field === 'string' && props.field !== 'text') return;
    if (typeof props.delta !== 'string' || props.delta.length === 0) return;

    const messageID = typeof props.messageID === 'string' && props.messageID
      ? props.messageID
      : null;
    if (assistantMessageID) {
      if (messageID && messageID !== assistantMessageID) return;
    } else if (messageID) {
      assistantMessageID = messageID;
    }

    try {
      onTextDelta(props.delta);
    } catch {
      // Caller callback failures must not abort generate or leave the hub broken.
    }
  });

  return typeof unsubscribe === 'function' ? unsubscribe : null;
}

/**
 * Generate assistant text through OpenCode's connected providers.
 * Sessionless generate if the binary exposes it; otherwise a throwaway
 * archived session used only as a tools-denied text generator.
 *
 * V2 session.prompt only forwards { id, prompt, delivery, resume } and drops
 * model/parts/tools. Use promptAsync (body still has model, parts, tools,
 * system, agent) then wait for idle and read session.messages.
 *
 * Optional internal streaming: pass `onTextDelta(text)` plus a live
 * `globalEventHub` (same hub as UI SSE). On the throwaway path only, real
 * `message.part.delta` tokens for this session are forwarded. Sessionless
 * `/generate` JSON cannot emit deltas — onTextDelta is skipped (no fake
 * typewriter). Public HTTP completions stay non-streaming.
 */
export async function generateOpenCodeText({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  providerID,
  modelID,
  messages,
  fetchImpl = globalThis.fetch.bind(globalThis),
  clientFactory,
  ensureTempDirectory,
  detect = detectSessionlessGenerate,
  forwardImageParts = false,
  onTextDelta = null,
  globalEventHub = null,
  signal: parentSignal = null,
  timeoutMs = GENERATE_TIMEOUT_MS,
  settlePollMs = SETTLE_POLL_MS,
}) {
  parentSignal?.throwIfAborted();
  if (!providerID || !modelID) {
    const error = new Error('providerID and modelID are required');
    error.code = 'validation_error';
    throw error;
  }
  const flattened = flattenMessages(messages);
  const promptFiles = filesForPrompt(flattened.files, forwardImageParts);
  if (!flattened.prompt && promptFiles.length === 0) {
    const error = new Error('messages must include a user turn');
    error.code = 'validation_error';
    throw error;
  }

  const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
  const headers = getOpenCodeAuthHeaders() || {};
  const probe = await detect({ fetchImpl, baseUrl, headers, client: clientFactory?.() });
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  const requestSignal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const stallMs = positiveMs(timeoutMs, GENERATE_TIMEOUT_MS);
  const abortGenerate = (message) => {
    if (controller.signal.aborted) return;
    controller.abort(new Error(message));
  };
  // Idle deadline only: live busy/delta/incomplete assistant progress
  // must not look like "the model hung". There is no wall-clock cap.
  let stallTimer = setTimeout(() => {
    abortGenerate(`OpenCode LLM generate timed out after ${stallMs}ms without progress`);
  }, stallMs);
  const bumpTimeout = () => {
    if (controller.signal.aborted) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      abortGenerate(`OpenCode LLM generate timed out after ${stallMs}ms without progress`);
    }, stallMs);
  };

  try {
    if (probe.available && probe.mode === 'http' && probe.url) {
      return await generateViaSessionless({
        fetchImpl,
        url: probe.url,
        headers,
        providerID,
        modelID,
        messages: forwardImageParts
          ? messages
          : messages.map((message) => {
            if (!Array.isArray(message?.parts)) return message;
            const parts = message.parts.filter((part) => part?.type !== 'file' || !String(part.mime || '').startsWith('image/'));
            return parts.length === message.parts.length ? message : { ...message, parts };
          }),
        signal: requestSignal,
      });
    }

    const workingDirectory = await ensureTempDirectory({
      agentName: LLM_AGENT_NAME,
      agentMarkdown: AGENT_MARKDOWN,
    });
    const client = clientFactory
      ? clientFactory()
      : createOpencodeClient({ baseUrl, directory: workingDirectory, headers });

    let toolIds;
    try {
      toolIds = await client.tool.ids({ directory: workingDirectory });
    } catch (error) {
      failGenerate(`OpenCode tool.ids failed: ${error?.message || 'tool.ids failed'}`);
    }
    if (toolIds?.error) {
      failGenerate(`OpenCode tool.ids failed: ${sdkErrorMessage(toolIds, 'tool.ids failed')}`);
    }
    const tools = deniedTools(Array.isArray(toolIds?.data) ? toolIds.data : []);

    const created = await client.session.create({
      directory: workingDirectory,
      title: '[openchamber-llm] generate',
      agent: LLM_AGENT_NAME,
      // Session fence: deny every native OpenCode/MCP/skill tool for this throwaway.
      permission: LLM_SESSION_DENY_PERMISSION,
      metadata: { openchamber: { llm: { purpose: 'chat-completions' } } },
    }, { signal: requestSignal });
    const sessionID = created?.data?.id;
    if (created?.error || !sessionID) {
      failGenerate(`OpenCode LLM session create failed: ${sdkErrorMessage(created, 'create failed')}`);
    }

    let unsubscribeDeltas = null;
    try {
      const archiveAt = Date.now();
      let archived = await client.session.update({
        sessionID,
        directory: workingDirectory,
        time: { archived: archiveAt },
      });
      if (isMissing(archived)) {
        archived = await client.session.update({
          sessionID,
          directory: workingDirectory,
          time: { archived: archiveAt },
        });
      }
      if (archived?.error) {
        failGenerate(`OpenCode LLM session archive failed: ${sdkErrorMessage(archived, 'archive failed')}`);
      }

      // Subscribe before promptAsync so early message.part.delta tokens are not missed.
      unsubscribeDeltas = subscribeThrowawayTextDeltas({
        globalEventHub,
        sessionID,
        onTextDelta: (text) => {
          bumpTimeout();
          if (typeof onTextDelta === 'function') onTextDelta(text);
        },
      });

      // promptAsync still forwards model/parts/tools. v2 session.prompt does not.
      const prompted = await client.session.promptAsync({
        sessionID,
        directory: workingDirectory,
        agent: LLM_AGENT_NAME,
        model: { providerID, modelID },
        ...(flattened.system ? { system: flattened.system } : {}),
        tools,
        parts: [
          { type: 'text', text: flattened.prompt, synthetic: false },
          ...promptFiles,
        ],
      }, { signal: requestSignal });
      if (!promptAdmitted(prompted)) {
        failGenerate(`OpenCode LLM promptAsync failed: ${sdkErrorMessage(prompted, 'promptAsync failed')}`);
      }
      bumpTimeout();

      let text = assistantTextFromPrompt(prompted?.data ?? prompted);
      if (!text.trim()) {
        const settled = await waitForIdleAssistant({
          client,
          sessionID,
          directory: workingDirectory,
          signal: requestSignal,
          onProgress: bumpTimeout,
          settlePollMs,
        });
        text = assistantTextFromMessages(settled);
      }
      if (!text.trim()) {
        failGenerate('OpenCode LLM generator returned no assistant text');
      }
      return { text: text.trim(), source: 'throwaway-session' };
    } finally {
      try {
        unsubscribeDeltas?.();
      } catch {
        // Unsubscribe must not mask generate errors or block session delete.
      }
      unsubscribeDeltas = null;
      try {
        const deleted = await client.session.delete({ sessionID, directory: workingDirectory });
        if (deleted?.error) {
          console.warn(
            '[llm] failed to delete throwaway OpenCode session:',
            sdkErrorMessage(deleted, 'delete failed'),
          );
        }
      } catch (error) {
        console.warn('[llm] failed to delete throwaway OpenCode session:', error?.message || error);
      }
    }
  } finally {
    clearTimeout(stallTimer);
  }
}

export const _test = {
  flattenMessages,
  filesForPrompt,
  describeContactFilePart,
  deniedTools,
  assistantTextFromPrompt,
  assistantTextFromMessages,
  eventPayload,
  eventDeltaProperties,
  subscribeThrowawayTextDeltas,
  LLM_AGENT_NAME,
  AGENT_MARKDOWN,
  LLM_SESSION_DENY_PERMISSION,
  GENERATE_TIMEOUT_MS,
};
