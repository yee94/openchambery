import { createOpencodeClient } from '@opencode-ai/sdk/v2';

const LLM_AGENT_NAME = 'openchamber-llm';
const GENERATE_TIMEOUT_MS = 90_000;

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

const sdkErrorMessage = (result, fallback) => {
  const status = result?.error?.status ?? result?.error?.statusCode ?? result?.status;
  const message = result?.error?.message || result?.error?.data?.message || fallback;
  return status ? `${message} (${status})` : message;
};

const assistantTextFromPrompt = (data) => {
  const parts = Array.isArray(data?.parts) ? data.parts : Array.isArray(data?.data?.parts) ? data.data.parts : [];
  const text = parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  if (text.trim()) return text;
  const info = data?.info ?? data?.data?.info;
  if (typeof info?.error === 'string' && info.error) {
    throw new Error(info.error);
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

/**
 * Detect a sessionless generate endpoint on the running OpenCode.
 * Bundled 1.18.4 does not expose POST /generate; keep the probe so a later
 * OpenCode that does can be used without changing the public completions API.
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
      if (response.status !== 404 && response.status !== 405) {
        return { available: true, mode: 'http', url };
      }
    } catch {
      // Probe failure is not a generate capability.
    }
  }
  return { available: false, mode: 'throwaway-session' };
}

const flattenMessages = (messages) => {
  const system = [];
  const turns = [];
  for (const message of messages) {
    if (!message || typeof message.content !== 'string') continue;
    if (message.role === 'system') system.push(message.content);
    else if (message.role === 'user' || message.role === 'assistant') {
      turns.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`);
    }
  }
  return {
    system: system.join('\n\n').trim(),
    prompt: turns.join('\n\n').trim(),
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
    throw new Error(`OpenCode generate failed (${response.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const payload = await response.json();
  const text = typeof payload?.text === 'string'
    ? payload.text
    : typeof payload?.message === 'string'
      ? payload.message
      : '';
  if (!text.trim()) throw new Error('OpenCode generate returned no text');
  return { text: text.trim(), source: 'generate' };
}

/**
 * Generate assistant text through OpenCode's connected providers.
 * Sessionless generate if the binary exposes it; otherwise a throwaway
 * archived session used only as a tools-denied text generator.
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
  if (!flattened.prompt) {
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
      throw new Error(`OpenCode LLM session create failed: ${sdkErrorMessage(created, 'create failed')}`);
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
        throw new Error(`OpenCode LLM session archive failed: ${sdkErrorMessage(archived, 'archive failed')}`);
      }

      // session.prompt (sync) returns the assistant turn. This is a throwaway
      // text generator — not the Assistant contact harness / transcript.
      const prompted = await client.session.prompt({
        sessionID,
        directory: workingDirectory,
        agent: LLM_AGENT_NAME,
        model: { providerID, modelID },
        ...(flattened.system ? { system: flattened.system } : {}),
        tools,
        parts: [{ type: 'text', text: flattened.prompt, synthetic: false }],
      }, { signal: controller.signal });
      if (prompted?.error) {
        throw new Error(`OpenCode LLM prompt failed: ${sdkErrorMessage(prompted, 'prompt failed')}`);
      }
      const text = assistantTextFromPrompt(prompted?.data ?? prompted);
      if (!text.trim()) {
        throw new Error('OpenCode LLM generator returned no assistant text');
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
  deniedTools,
  assistantTextFromPrompt,
  LLM_AGENT_NAME,
  AGENT_MARKDOWN,
};
