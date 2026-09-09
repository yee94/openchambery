import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** @type {string | null} */
let tempDirectory = null;
/** @type {Promise<string> | null} */
let inflight = null;
/** Serialize markdown refreshes so concurrent ensure cannot interleave one file. */
let writeChain = Promise.resolve();

const writeAgentMarkdown = async (root, agentName, agentMarkdown) => {
  const agentDir = path.join(root, '.opencode', 'agent');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, `${agentName}.md`), agentMarkdown, 'utf8');
};

const enqueueWrite = (work) => {
  const run = writeChain.catch(() => {}).then(work);
  writeChain = run.catch(() => {});
  return run;
};

export async function ensureLlmTempDirectory({ agentName, agentMarkdown }) {
  // Long-lived servers / HMR must refresh the hidden agent markdown so a
  // permission-format fix is not stuck behind a stale temp directory.
  // Concurrent first callers share one mkdtemp; every caller still writes its
  // markdown after settle so a mid-flight ensure cannot skip a newer body.
  // Concurrent warm writes are serialized (last committed body wins).
  if (!tempDirectory) {
    if (!inflight) {
      inflight = (async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-llm-'));
        tempDirectory = root;
        return root;
      })().finally(() => {
        inflight = null;
      });
    }
    await inflight;
  }
  const root = tempDirectory;
  await enqueueWrite(() => writeAgentMarkdown(root, agentName, agentMarkdown));
  return root;
}

export async function stopLlmTempDirectory() {
  const dir = tempDirectory;
  tempDirectory = null;
  inflight = null;
  writeChain = Promise.resolve();
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of the throwaway generator workspace.
  }
}
