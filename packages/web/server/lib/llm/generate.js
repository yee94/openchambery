import { createOpencodeClient } from '@opencode-ai/sdk/v2';

const LLM_AGENT_NAME = 'openchamber-llm';
const GENERATE_TIMEOUT_MS = 90_000;
const SETTLE_POLL_MS = 250;
const INCOMPLETE_ASSISTANT_SETTLE_PROBES = 2;
const EMPTY_IDLE_PROBES = 5;

const AGENT_MARKDOWN = `---
mode: primary
hidden: true
permissions:
  - action: "*"
    resource: "*"
    effect: deny
---

You are a text generator. Reply with only the requested text. Do not use tools.
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
  const timer = setTimeout(resolve, ms);
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

const waitForIdleAssistant = async ({ client, sessionID, directory, signal }) => {
  let incompleteAssistantProbes = 0;
  let emptyIdleProbes = 0;

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
      await sleep(SETTLE_POLL_MS, signal);
      continue;
    }

    try {
      const messagesResult = await client.session.messages({
        sessionID,
        directory,
        limit: 20,
      }, { signal });
      if (!messagesResult?.error && Array.isArray(messagesResult?.data)) {
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

    await sleep(SETTLE_POLL_MS, signal);
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

/**
 * Generate assistant text through OpenCode's connected providers.
 * Sessionless generate if the binary exposes it; otherwise a throwaway
 * archived session used only as a tools-denied text generator.
 *
 * V2 session.prompt only forwards { id, prompt, delivery, resume } and drops
 * model/parts/tools. Use promptAsync (body still has model, parts, tools,
 * system, agent) then wait for idle and read session.messages.
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
}) {
  if (!providerID || !modelID) {
    const error = new Error('providerID and modelID are required');
    error.code = 'validation_error';
    throw error;
  }
  const flattened = flattenMessages(messages);
  if (!flattened.prompt && flattened.files.length === 0) {
    const error = new Error('messages must include a user turn');
    error.code = 'validation_error';
    throw error;
  }

  const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
  const headers = getOpenCodeAuthHeaders() || {};
  const probe = await detect({ fetchImpl, baseUrl, headers, client: clientFactory?.() });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`OpenCode LLM generate timed out after ${GENERATE_TIMEOUT_MS}ms`)), GENERATE_TIMEOUT_MS);

  try {
    if (probe.available && probe.mode === 'http' && probe.url) {
      return await generateViaSessionless({
        fetchImpl,
        url: probe.url,
        headers,
        providerID,
        modelID,
        messages,
        signal: controller.signal,
      });
    }

    const workingDirectory = await ensureTempDirectory({
      agentName: LLM_AGENT_NAME,
      agentMarkdown: AGENT_MARKDOWN,
    });
    const client = clientFactory
      ? clientFactory()
      : createOpencodeClient({ baseUrl, directory: workingDirectory, headers });

    const toolIds = await client.tool.ids({ directory: workingDirectory }).catch(() => ({ data: [] }));
    const tools = deniedTools(Array.isArray(toolIds?.data) ? toolIds.data : []);

    const created = await client.session.create({
      directory: workingDirectory,
      title: '[openchamber-llm] generate',
      agent: LLM_AGENT_NAME,
      metadata: { openchamber: { llm: { purpose: 'chat-completions' } } },
    }, { signal: controller.signal });
    const sessionID = created?.data?.id;
    if (created?.error || !sessionID) {
      failGenerate(`OpenCode LLM session create failed: ${sdkErrorMessage(created, 'create failed')}`);
    }

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
          ...flattened.files,
        ],
      }, { signal: controller.signal });
      if (!promptAdmitted(prompted)) {
        failGenerate(`OpenCode LLM promptAsync failed: ${sdkErrorMessage(prompted, 'promptAsync failed')}`);
      }

      let text = assistantTextFromPrompt(prompted?.data ?? prompted);
      if (!text.trim()) {
        const settled = await waitForIdleAssistant({
          client,
          sessionID,
          directory: workingDirectory,
          signal: controller.signal,
        });
        text = assistantTextFromMessages(settled);
      }
      if (!text.trim()) {
        failGenerate('OpenCode LLM generator returned no assistant text');
      }
      return { text: text.trim(), source: 'throwaway-session' };
    } finally {
      try {
        await client.session.delete({ sessionID, directory: workingDirectory });
      } catch (error) {
        console.warn('[llm] failed to delete throwaway OpenCode session:', error?.message || error);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

export const _test = {
  flattenMessages,
  describeContactFilePart,
  deniedTools,
  assistantTextFromPrompt,
  assistantTextFromMessages,
  LLM_AGENT_NAME,
  AGENT_MARKDOWN,
};
