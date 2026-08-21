import { spawn } from 'node:child_process';

/**
 * Collect stdout from a local `tar …` into a Buffer.
 *
 * Callers buffer the entire archive in memory; TargetExecutor.putTar accepts
 * Buffer | Uint8Array only.
 *
 * @param {string[]} tarArgs
 * @param {{ windowsHide?: boolean }} [spawnOptions]
 * @returns {Promise<Buffer>}
 */
export const collectLocalTarBuffer = (tarArgs, spawnOptions = {}) => new Promise((resolve, reject) => {
  const child = spawn('tar', tarArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(spawnOptions.windowsHide ? { windowsHide: true } : {}),
  });
  /** @type {Buffer[]} */
  const chunks = [];
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0) {
      reject(new Error((stderr || 'Local tar failed').trim()));
      return;
    }
    resolve(Buffer.concat(chunks));
  });
});
