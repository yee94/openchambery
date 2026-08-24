import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

// Temporary OpenCode session path for providers that lack a dedicated
// small-model adapter (plugin providers, region/credential-chain, …).
// Auth, endpoint rewrite, and token refresh stay inside the OpenCode runtime.

export const SMALL_MODEL_AGENT_NAME = 'openchamber-smallmodel';
export const SESSION_SETTLE_TIMEOUT_MS = 60_000;
const SESSION_SETTLE_POLL_MS = 1_000;
const ARCHIVE_RETRY_MS = 25;
const INCOMPLETE_ASSISTANT_SETTLE_PROBES = 2;

const AGENT_MARKDOWN = `---
mode: primary
hidden: true
permissions:
  - action: "*"
    resource: "*"
    effect: deny
---

You are a utility text generator. Reply with only the requested text. Do not use tools.
`;

/** @type {string | null} */
let tempDirectory = null;
/** @type {Promise<string> | null} */
let tempDirectoryInflight = null;

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

const sdkErrorMessage = (result, fallback) => {
  const status = result?.error?.status ?? result?.error?.statusCode ?? result?.status;
  const message = result?.error?.message || result?.error?.data?.message || fallback;
  return status ? `${message} (${status})` : message;
};

const readMessageInfo = (message) => {
  if (!message || typeof message !== 'object') return null;
  if (message.info && typeof message.info === 'object') return message.info;
  return message;
};

const assistantTextFromMessages = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const info = readMessageInfo(message);
    if (info?.role !== 'assistant') continue;
    if (info.error) {
      const detail = typeof info.error === 'string'
        ? info.error
        : (info.error?.message || JSON.stringify(info.error));
      throw new Error(`OpenCode small-model session assistant error: ${detail}`);
    }
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    const text = parts
      .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
    return text;
  }
  return '';
};

const ensureTempDirectory = async () => {
  if (tempDirectory) return tempDirectory;
  if (!tempDirectoryInflight) {
    tempDirectoryInflight = (async () => {
      const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openchamber-smallmodel-'));
      const agentDir = path.join(root, '.opencode', 'agent');
      await fsPromises.mkdir(agentDir, { recursive: true });
      await fsPromises.writeFile(
        path.join(agentDir, `${SMALL_MODEL_AGENT_NAME}.md`),
        AGENT_MARKDOWN,
        'utf8',
      );
      tempDirectory = root;
      return root;
    })().finally(() => {
      tempDirectoryInflight = null;
    });
  }
  return tempDirectoryInflight;
};

const createClient = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, directory }) => {
  const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
  return createOpencodeClient({
    baseUrl,
    directory,
    headers: getOpenCodeAuthHeaders(),
  });
};

const archiveCreatedSession = async (client, sessionID, directory) => {
  const archiveAt = Date.now();
  const update = () => client.session.update({
    sessionID,
    directory,
    time: { archived: archiveAt },
  });
  let result = await update();
  if (isMissing(result)) {
    await sleep(ARCHIVE_RETRY_MS);
    result = await update();
  }
  if (result?.error || isMissing(result)) {
    throw new Error(`OpenCode small-model session archive failed: ${sdkErrorMessage(result, 'archive failed')}`);
  }
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
      await sleep(SESSION_SETTLE_POLL_MS, signal);
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
            const detail = typeof lastInfo.error === 'string'
              ? lastInfo.error
              : (lastInfo.error?.message || JSON.stringify(lastInfo.error));
            throw new Error(`OpenCode small-model session assistant error: ${detail}`);
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
          if (emptyIdleProbes >= 5 && lastInfo?.role === 'user') {
            throw new Error('OpenCode small-model session ended without assistant response');
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof Error && error.message.startsWith('OpenCode small-model')) throw error;
    }

    await sleep(SESSION_SETTLE_POLL_MS, signal);
  }
};

/**
 * Generate text via a throwaway OpenCode session (deny-all hidden agent).
 * Errors are never masked as empty success.
 *
 * @param {{
 *   buildOpenCodeUrl: (pathname: string, search?: string) => string,
 *   getOpenCodeAuthHeaders: () => Record<string, string>,
 *   providerID: string,
 *   modelID: string,
 *   prompt: string,
 *   system?: string,
 *   purpose?: string,
 *   directory?: string,
 * }} options
 */
export async function generateViaOpenCodeSession({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  providerID,
  modelID,
  prompt,
  system,
  purpose,
  settleTimeoutMs = SESSION_SETTLE_TIMEOUT_MS,
}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('OpenCode small-model session requires a prompt');
  }
  if (typeof providerID !== 'string' || !providerID.trim() || typeof modelID !== 'string' || !modelID.trim()) {
    throw new Error('OpenCode small-model session requires providerID and modelID');
  }

  const purposeLabel = typeof purpose === 'string' && purpose.trim() ? purpose.trim() : 'utility';
  const budgetMs = Number(settleTimeoutMs) > 0 ? Number(settleTimeoutMs) : SESSION_SETTLE_TIMEOUT_MS;
  const workingDirectory = await ensureTempDirectory();
  const client = createClient({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    directory: workingDirectory,
  });

  let sessionID = null;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`OpenCode small-model session timed out after ${budgetMs}ms`));
  }, budgetMs);

  try {
    const createResult = await client.session.create({
      directory: workingDirectory,
      title: `[small-model] ${purposeLabel}`,
      agent: SMALL_MODEL_AGENT_NAME,
      metadata: {
        openchamber: {
          smallModel: { purpose: purposeLabel },
        },
      },
    }, { signal: controller.signal });

    sessionID = createResult?.data?.id;
    if (createResult?.error || !sessionID) {
      throw new Error(`OpenCode small-model session create failed: ${sdkErrorMessage(createResult, 'create failed')}`);
    }

    // Archive before prompting so ordinary session lists never flash system sessions.
    await archiveCreatedSession(client, sessionID, workingDirectory);

    const promptResult = await client.session.promptAsync({
      sessionID,
      directory: workingDirectory,
      agent: SMALL_MODEL_AGENT_NAME,
      model: { providerID, modelID },
      ...(typeof system === 'string' && system.trim() ? { system: system.trim() } : {}),
      parts: [{ type: 'text', text: prompt, synthetic: false }],
    }, { signal: controller.signal });

    if (!promptAdmitted(promptResult)) {
      throw new Error(`OpenCode small-model prompt_async failed: ${sdkErrorMessage(promptResult, 'prompt_async failed')}`);
    }

    const messages = await waitForIdleAssistant({
      client,
      sessionID,
      directory: workingDirectory,
      signal: controller.signal,
    });
    const text = assistantTextFromMessages(messages);
    if (!text.trim()) {
      throw new Error('OpenCode small-model session returned no assistant text');
    }
    return text;
  } finally {
    clearTimeout(timeout);
    if (sessionID) {
      try {
        await client.session.delete({ sessionID, directory: workingDirectory });
      } catch (error) {
        console.warn(
          '[small-model] failed to delete temporary OpenCode session:',
          error?.message || error,
        );
      }
    }
  }
};

/** Best-effort cleanup of the lazy temp directory (agent markdown + empty root). */
export async function stop() {
  const dir = tempDirectory;
  tempDirectory = null;
  tempDirectoryInflight = null;
  if (!dir) return;
  try {
    await fsPromises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    // Sync fallback if async rm races a partially-created tree.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      console.warn('[small-model] failed to remove temp directory:', error?.message || error);
    }
  }
}

/** @internal test helpers */
export const _test = {
  getTempDirectory: () => tempDirectory,
  resetTempDirectory: () => {
    tempDirectory = null;
    tempDirectoryInflight = null;
  },
  AGENT_MARKDOWN,
};
