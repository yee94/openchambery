import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { OpenCode } from '@opencode/client';

// Temporary OpenCode path for providers that lack a dedicated small-model
// adapter (plugin providers, region/credential-chain, …).
// Auth, endpoint rewrite, and token refresh stay inside the OpenCode runtime.
//
// Prefer official `generate.text` (no session). The deny-all agent markdown in
// the lazy temp directory remains available if a future caller needs a session
// workspace, but pure-text small-model calls must not open coding sessions.

export const SMALL_MODEL_AGENT_NAME = 'openchamber-smallmodel';
export const SESSION_SETTLE_TIMEOUT_MS = 60_000;

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

const clientErrorMessage = (error, fallback) => {
  if (typeof error?.message === 'string' && error.message.trim()) return error.message;
  return fallback;
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

const createClient = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
  return OpenCode.make({
    baseUrl,
    headers: getOpenCodeAuthHeaders(),
  });
};

/**
 * Generate text via official OpenCode `generate.text`.
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
 *   settleTimeoutMs?: number,
 * }} options
 */
export async function generateViaOpenCodeSession({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  providerID,
  modelID,
  prompt,
  system,
  purpose: _purpose,
  directory,
  settleTimeoutMs = SESSION_SETTLE_TIMEOUT_MS,
}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('OpenCode small-model session requires a prompt');
  }
  if (typeof providerID !== 'string' || !providerID.trim() || typeof modelID !== 'string' || !modelID.trim()) {
    throw new Error('OpenCode small-model session requires providerID and modelID');
  }

  const budgetMs = Number(settleTimeoutMs) > 0 ? Number(settleTimeoutMs) : SESSION_SETTLE_TIMEOUT_MS;
  // Keep the deny-all agent workspace warm for isolation invariants / future
  // session needs, but pure text uses generate.text (no coding session).
  await ensureTempDirectory();

  const client = createClient({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
  });

  const locationDirectory = typeof directory === 'string' && directory.trim()
    ? directory.trim()
    : null;
  const location = locationDirectory ? { directory: locationDirectory } : undefined;

  const fullPrompt = [
    typeof system === 'string' && system.trim() ? system.trim() : '',
    prompt.trim(),
  ].filter(Boolean).join('\n\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`OpenCode small-model generate timed out after ${budgetMs}ms`));
  }, budgetMs);

  try {
    let result;
    try {
      result = await client.generate.text({
        ...(location ? { location } : {}),
        prompt: fullPrompt,
        model: { id: modelID, providerID },
      }, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error(`OpenCode small-model generate timed out after ${budgetMs}ms`);
      }
      throw new Error(
        `OpenCode small-model generate.text failed: ${clientErrorMessage(error, 'generate.text failed')}`,
      );
    }

    const text = typeof result?.text === 'string' ? result.text : '';
    if (!text.trim()) {
      throw new Error('OpenCode small-model generate.text returned no assistant text');
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

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
