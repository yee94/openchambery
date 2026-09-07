import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** @type {string | null} */
let tempDirectory = null;
/** @type {Promise<string> | null} */
let inflight = null;

export async function ensureLlmTempDirectory({ agentName, agentMarkdown }) {
  if (tempDirectory) return tempDirectory;
  if (!inflight) {
    inflight = (async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-llm-'));
      const agentDir = path.join(root, '.opencode', 'agent');
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, `${agentName}.md`), agentMarkdown, 'utf8');
      tempDirectory = root;
      return root;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export async function stopLlmTempDirectory() {
  const dir = tempDirectory;
  tempDirectory = null;
  inflight = null;
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of the throwaway generator workspace.
  }
}
