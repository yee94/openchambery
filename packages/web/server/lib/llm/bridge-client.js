import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OpenCode } from '@opencode/client';
import { LlmBridge, LLM_BRIDGE_VERSION } from './bridge-contract.js';

let directoryPromise;
export async function ensureLlmBridgeDirectory() {
  if (!directoryPromise) directoryPromise = (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-inference-'));
    try {
      const plugins = path.join(directory, '.opencode', 'plugins');
      await fs.mkdir(plugins, { recursive: true });
      const plugin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge-plugin.bundle.js');
      await fs.copyFile(plugin, path.join(plugins, 'yuri-llm.js'));
      return directory;
    } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
  })().catch(error => { directoryPromise = undefined; throw error; });
  return directoryPromise;
}

export async function stopLlmBridgeDirectory() {
  const pending = directoryPromise;
  directoryPromise = undefined;
  if (pending) await fs.rm(await pending, { recursive: true, force: true });
}

export async function generateCleanCompletion({ buildOpenCodeUrl, getOpenCodeAuthHeaders, clientFactory,
  providerID, modelID, variant, messages, tools, cacheKey = randomUUID(), maxOutputTokens, signal,
  ensureBridgeDirectory = ensureLlmBridgeDirectory,
}) {
  signal?.throwIfAborted();
  const client = clientFactory?.() ?? OpenCode.make({ baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''), headers: getOpenCodeAuthHeaders() });
  const directory = await ensureBridgeDirectory();
  const options = { location: { directory }, signal };
  const rpc = client.rpc(LlmBridge);
  // Loading this isolated Location activates only its own plugin file, without global config writes.
  await client.plugin.list({ location: { directory } }, { signal });
  let ready;
  for (let attempt = 0; ; attempt++) {
    try { ready = await rpc.ready({}, options); break; }
    catch (error) {
      if (signal?.aborted || error?.type !== 'rpc.unavailable' || attempt >= 20) throw error;
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 250);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  if (ready.version !== LLM_BRIDGE_VERSION) throw new Error('Incompatible Yuri LLM bridge');
  const result = await rpc.generate({ providerID, modelID, ...(variant ? { variant } : {}), messages,
    ...(tools ? { tools } : {}), cacheKey, ...(maxOutputTokens ? { maxOutputTokens } : {}),
  }, options);
  signal?.throwIfAborted();
  return { ...result, source: 'opencode.llm.bridge' };
}
