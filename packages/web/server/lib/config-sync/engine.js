import path from 'node:path';

import { assertPlanDirection } from './contract.js';
import { collectLocalTarBuffer } from './tar.js';

/**
 * Run a source-side plan against a TargetExecutor (probe → prepare → putTar* → finalize).
 * Direction-agnostic orchestration; ticket 02 only drives push from a local home snapshot.
 *
 * @param {{
 *   plan: object,
 *   executor: import('./contract.js').TargetExecutor,
 *   syncRunId: string,
 *   sourceHomedir: string,
 *   collectTar?: typeof collectLocalTarBuffer,
 * }} args
 */
export const applyConfigSyncPlan = async ({
  plan,
  executor,
  syncRunId,
  sourceHomedir,
  collectTar = collectLocalTarBuffer,
}) => {
  assertPlanDirection(plan);
  const home = String(sourceHomedir || '');
  const configDir = path.join(home, '.config', 'opencode');
  const tarEntries = [
    ...plan.files.map((entry) => entry.path),
    ...plan.directories.map((entry) => entry.path),
  ];
  const hasConfigPayload = tarEntries.length > 0;
  const hasAgentsPayload = Boolean(plan.agentsRoot);
  const hasAuthPayload = Boolean(plan.authFile);

  if (!hasConfigPayload && !hasAgentsPayload && !hasAuthPayload) {
    // Nothing to upload — preserve the historical short-circuit (no remote prepare).
    return {
      ok: true,
      files: plan.files.length,
      directories: plan.directories.length,
      deletes: plan.deletes.length,
      totalBytes: plan.totalBytes,
      agentsRoot: null,
      authFile: null,
      plan,
    };
  }

  const windowsHide = process.platform === 'win32';
  const configTarBuffer = hasConfigPayload
    ? await collectTar(['-h', '-czf', '-', '-C', configDir, ...tarEntries], { windowsHide })
    : null;
  const agentsTarBuffer = hasAgentsPayload
    ? await collectTar(['-h', '-czf', '-', '-C', home, '.agents'], { windowsHide })
    : null;
  const authShareDir = path.join(home, '.local', 'share', 'opencode');
  const authTarBuffer = hasAuthPayload
    ? await collectTar(['-h', '-czf', '-', '-C', authShareDir, 'auth.json'], { windowsHide })
    : null;

  await executor.prepare(plan, { syncRunId });

  if (configTarBuffer) {
    await executor.putTar({ kind: 'config', payload: configTarBuffer });
  }
  if (agentsTarBuffer) {
    await executor.putTar({ kind: 'agents', payload: agentsTarBuffer });
  }
  if (authTarBuffer) {
    // Only auth.json — never the rest of ~/.local/share/opencode (session DBs live there).
    await executor.putTar({ kind: 'auth', payload: authTarBuffer });
  }

  await executor.finalize(plan, { syncRunId });

  return {
    ok: true,
    files: plan.files.length,
    directories: plan.directories.length,
    deletes: plan.deletes.length,
    totalBytes: plan.totalBytes,
    agentsRoot: plan.agentsRoot ? { fileCount: plan.agentsRoot.fileCount } : null,
    authFile: plan.authFile ? { bytes: plan.authFile.bytes } : null,
    plan,
  };
};

/**
 * Preview helper: compute probe path list from a plan.
 * @param {object} plan
 */
export const probePathsForPlan = (plan) => {
  const probePaths = [
    ...(Array.isArray(plan?.files) ? plan.files.map((entry) => entry.path) : []),
    ...(Array.isArray(plan?.directories) ? plan.directories.map((entry) => entry.path) : []),
    ...(Array.isArray(plan?.deletes) ? plan.deletes : []),
  ];
  return [...new Set(probePaths)];
};
