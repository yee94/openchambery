import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./put-catalog.e2e-host.mjs', import.meta.url));
const repo = path.resolve(path.dirname(script), '../../../../..');

const waitForClose = (child, timeoutMs) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve({ code: child.exitCode, signal: child.signalCode });
    return;
  }
  const timer = setTimeout(() => resolve(null), timeoutMs);
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal });
  });
});

const stopOwnedChild = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForClose(child, 8_000)) return;
  child.kill('SIGKILL');
  await waitForClose(child, 5_000);
};

describe('scheduled task PUT catalog host e2e', () => {
  it('checks connected models through the real host, fixture, and project-config file', async () => {
    const child = spawn(process.execPath, [script], {
      cwd: repo,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
      const exit = await waitForClose(child, 90_000);
      if (!exit) {
        await stopOwnedChild(child);
      }
      const summary = JSON.parse(stdout.trim().split('\n').filter((line) => line.startsWith('{')).at(-1) || '{}');
      expect(exit, `${stderr.slice(-1500)}\n${stdout.slice(-1500)}`).toMatchObject({ code: 0 });
      expect(summary.exit.code).toBe(0);
      expect(summary.hits.some((entry) => (
        entry.path === '/api/provider'
        && entry.status === 503
        && entry.directory === summary.report.directory
      ))).toBe(true);
      expect(summary.hits.some((entry) => entry.path === '/api/model' && entry.status === 200 && entry.directory)).toBe(true);
      expect(summary.report.ok).toBe(true);
      expect(summary.report.disabledFromEnabled).toBe(true);
      expect(summary.report.directory).toBeTruthy();
      expect(summary.report.underDataDir).toBe(false);
      expect(summary.report.configPath).toContain(`${path.sep}.config${path.sep}openchamber${path.sep}projects${path.sep}`);
    } finally {
      await stopOwnedChild(child);
    }
  }, 120_000);
});
