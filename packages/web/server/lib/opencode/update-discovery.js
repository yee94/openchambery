import { OPENCODE2_NPM_PACKAGE } from './opencode2-pin.js';

const stableVersion = (value) => typeof value === 'string' && /^2\.\d+\.\d+$/.test(value) ? value : null;

// One bounded registry snapshot per host, shared by all connected clients.
export function createOpenCodeUpdateDiscovery({ fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  let snapshot = null;
  let expiresAt = 0;
  let pending = null;

  const registry = () => {
    if (snapshot && now() < expiresAt) return Promise.resolve(snapshot);
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(OPENCODE2_NPM_PACKAGE)}/latest`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`OpenCode registry returned HTTP ${response.status}`);
        const version = stableVersion((await response.json()).version);
        if (!version) throw new Error('OpenCode registry did not return a stable 2.x version');
        snapshot = { version, error: null };
        expiresAt = now() + 5 * 60_000;
      } catch (error) {
        snapshot = { version: snapshot?.version ?? null, error: error instanceof Error ? error.message : 'OpenCode registry check failed' };
        expiresAt = now() + 30_000;
      }
      return snapshot;
    })().finally(() => { pending = null; });
    return pending;
  };

  return async () => {
    const remote = await registry();
    if (remote.error) throw new Error(remote.error);
    return remote.version;
  };
}
