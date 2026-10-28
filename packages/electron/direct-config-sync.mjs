import {
  SYNC_DIRECTION_PULL,
  SYNC_DIRECTION_PUSH,
  applyConfigSyncPlan,
  collectLocalTarBuffer,
  createDirectHostSyncTarget,
  extractTarGzBuffer,
  finalizeLocalSyncDestination,
  normalizeSyncSelections,
  planOpenCodeConfigSync,
  planOpenCodeConfigSyncFromInventory,
  prepareLocalSyncDestination,
  syncTargetIdForDirectHost,
} from '@yuriai/web/server/lib/config-sync/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Build Authorization headers for a direct Yuri host.
 * @param {{ clientToken?: string, requestHeaders?: Record<string, string> }} host
 */
export const buildDirectHostAuthHeaders = (host) => {
  const headers = {
    Accept: 'application/json',
  };
  const token = typeof host?.clientToken === 'string' ? host.clientToken.trim() : '';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (host?.requestHeaders && typeof host.requestHeaders === 'object') {
    for (const [key, value] of Object.entries(host.requestHeaders)) {
      if (typeof key === 'string' && typeof value === 'string' && key.trim() && value.trim()) {
        if (key.trim().toLowerCase() === 'authorization') continue;
        headers[key.trim()] = value.trim();
      }
    }
  }
  return headers;
};

const resolveApiBase = (host) => {
  const raw = typeof host?.apiUrl === 'string' && host.apiUrl.trim()
    ? host.apiUrl.trim()
    : (typeof host?.url === 'string' ? host.url.trim() : '');
  if (!raw || raw.startsWith('relay://')) {
    throw new Error('Direct config sync requires a reachable apiUrl');
  }
  return raw.replace(/\/+$/, '');
};

/**
 * Direct-host TargetExecutor over Yuri HTTP config-sync routes.
 * putTar sends Buffer | Uint8Array as a single request body.
 */
export const createDirectTargetExecutor = ({ host, fetchImpl = fetch }) => {
  const base = resolveApiBase(host);
  const headers = buildDirectHostAuthHeaders(host);

  const jsonFetch = async (method, routePath, body) => {
    const response = await fetchImpl(`${base}${routePath}`, {
      method,
      headers: {
        ...headers,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error || `Direct sync ${method} ${routePath} failed (${response.status})`);
      if (typeof payload?.code === 'string') error.code = payload.code;
      throw error;
    }
    return payload;
  };

  const bodyFromPayload = (payload) => {
    if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
      return payload;
    }
    throw new Error('putTar payload must be Buffer or Uint8Array');
  };

  return {
    async magpieInventory() {
      const result = await jsonFetch('GET', '/api/yuri/config-sync/magpie/inventory');
      if (typeof result.magpie?.available !== 'boolean' || typeof result.magpie?.installed !== 'boolean') throw new Error('Invalid Magpie inventory');
      return result.magpie;
    },

    async importMagpie(payload) {
      const response = await fetchImpl(`${base}/api/yuri/config-sync/magpie`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: payload,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.error || 'Magpie sync failed on destination', {
          cause: typeof result?.detail === 'string' && result.detail.trim() ? new Error(result.detail.trim()) : undefined,
        });
      }
      return result;
    },

    async credentialInventory() {
      const result = await jsonFetch('GET', '/api/yuri/config-sync/credentials/inventory');
      if (!Object.hasOwn(result, 'providerCredentials')) throw new Error('Invalid provider credential inventory');
      return result.providerCredentials;
    },

    async importCredentials(payload) {
      const response = await fetchImpl(`${base}/api/yuri/config-sync/credentials`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: payload,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.error || 'Provider credential sync failed on destination');
    },

    async probe(plan) {
      const result = await jsonFetch('POST', '/api/yuri/config-sync/probe', { plan });
      return {
        remoteExisting: Array.isArray(result.remoteExisting) ? result.remoteExisting : [],
        remoteAgentsRootExists: result.remoteAgentsRootExists === true,
        remoteProviderCredentialsExists: result.remoteProviderCredentialsExists === true,
        inventory: result.inventory,
      };
    },

    async prepare(plan, ctx) {
      await jsonFetch('POST', '/api/yuri/config-sync/prepare', {
        plan,
        syncRunId: ctx.syncRunId,
      });
    },

    async putTar({ kind, payload, syncRunId }) {
      const body = bodyFromPayload(payload);
      const response = await fetchImpl(
        `${base}/api/yuri/config-sync/put/${encodeURIComponent(kind)}?syncRunId=${encodeURIComponent(syncRunId)}`,
        {
          method: 'PUT',
          headers: {
            ...headers,
            'Content-Type': kind === 'credentials' || kind === 'magpie' ? 'application/octet-stream' : 'application/gzip',
            'Content-Length': String(body.byteLength),
          },
          body,
        },
      );
      const payloadJson = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payloadJson?.error || `Direct sync put ${kind} failed (${response.status})`);
        if (typeof payloadJson?.code === 'string') error.code = payloadJson.code;
        throw error;
      }
    },

    async finalize(_plan, ctx) {
      return jsonFetch('POST', '/api/yuri/config-sync/finalize', { syncRunId: ctx.syncRunId });
    },

    async abort(syncRunId) {
      await jsonFetch('POST', '/api/yuri/config-sync/abort', { syncRunId });
    },

    async download(kind) {
      const response = await fetchImpl(
        `${base}/api/yuri/config-sync/download/${encodeURIComponent(kind)}`,
        { method: 'GET', headers },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload?.error || `Direct sync download ${kind} failed (${response.status})`);
        if (typeof payload?.code === 'string') error.code = payload.code;
        throw error;
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    },
  };
};

/**
 * Desktop-side orchestration for direct-host config sync (push + pull).
 */
export const createDirectConfigSyncController = ({
  syncRunStore,
  runExclusiveForTarget,
  getLocalExecutor,
}) => {
  const preview = async (host, options = {}) => {
    const target = createDirectHostSyncTarget(host.id);
    const targetId = target.id;
    const direction = options.direction === SYNC_DIRECTION_PULL ? SYNC_DIRECTION_PULL : SYNC_DIRECTION_PUSH;
    const selections = normalizeSyncSelections(options.selections, {
      includeProviderCredentials: options.selections?.providerCredentials === true,
    });

    return runExclusiveForTarget(targetId, 'preview', async ({ syncRunId }) => {
      const executor = createDirectTargetExecutor({ host });
      if (direction === SYNC_DIRECTION_PULL) {
        const probe = await executor.probe({ selections });
        const plan = planOpenCodeConfigSyncFromInventory(probe.inventory || {}, {
          direction: SYNC_DIRECTION_PULL,
          syncRunId,
          sourceTargetId: targetId,
          targetId: 'local',
          selections,
        });
        const home = os.homedir();
        const configDir = path.join(home, '.config', 'opencode');
        const localExisting = [];
        for (const entry of [...plan.files, ...plan.directories]) {
          try {
            fs.accessSync(path.join(configDir, entry.path));
            localExisting.push(entry.path);
          } catch {
            // absent
          }
        }
        return {
          plan,
          // Pull preview: key stays `remoteExisting` for wizard shape compatibility,
          // but the values are paths that already exist locally (destination).
          remoteExisting: localExisting,
          remoteAgentsRootExists: (() => {
            try { return fs.statSync(path.join(home, '.agents')).isDirectory(); } catch { return false; }
          })(),
          remoteProviderCredentialsExists: selections.providerCredentials ? Boolean(await getLocalExecutor().credentialInventory()) : false,
        };
      }

      const plan = planOpenCodeConfigSync(os.homedir(), {
        magpie: await getLocalExecutor().magpieInventory(),
        providerCredentials: selections.providerCredentials ? await getLocalExecutor().credentialInventory() : null,
        direction: SYNC_DIRECTION_PUSH,
        syncRunId,
        sourceTargetId: 'local',
        targetId,
        selections,
      });
      const probe = await executor.probe(plan);
      return { plan, ...probe };
    });
  };

  const apply = async (host, options = {}) => {
    const target = createDirectHostSyncTarget(host.id);
    const targetId = target.id;
    const direction = options.direction === SYNC_DIRECTION_PULL ? SYNC_DIRECTION_PULL : SYNC_DIRECTION_PUSH;
    const selections = normalizeSyncSelections(options.selections, {
      includeProviderCredentials: options.selections?.providerCredentials === true,
    });

    return runExclusiveForTarget(targetId, 'apply', async ({ syncRunId }) => {
      const executor = createDirectTargetExecutor({ host });
      const home = os.homedir();

      if (direction === SYNC_DIRECTION_PULL) {
        const probe = await executor.probe({ selections });
        const plan = planOpenCodeConfigSyncFromInventory(probe.inventory || {}, {
          direction: SYNC_DIRECTION_PULL,
          syncRunId,
          sourceTargetId: targetId,
          targetId: 'local',
          selections,
        });
        const hasPayload = plan.files.length > 0 || plan.directories.length > 0 || Boolean(plan.agentsRoot) || Boolean(plan.providerCredentials) || Boolean(plan.magpie);
        if (!hasPayload) {
          return {
            ok: true,
            files: 0,
            directories: 0,
            deletes: plan.deletes.length,
            totalBytes: 0,
            agentsRoot: null,
            providerCredentials: null,
            plan,
          };
        }
        const configTar = (plan.files.length > 0 || plan.directories.length > 0)
          ? await executor.download('config')
          : null;
        const agentsTar = plan.agentsRoot ? await executor.download('agents') : null;
        const credentialPayload = plan.providerCredentials ? await executor.download('credentials') : null;
        const magpiePayload = plan.magpie ? await executor.download('magpie') : null;
        await prepareLocalSyncDestination(home, plan, { syncRunId });
        const magpieResult = magpiePayload ? await getLocalExecutor().importMagpie(magpiePayload) : null;
        if (configTar?.length) await extractTarGzBuffer(configTar, path.join(home, '.config', 'opencode'));
        if (agentsTar?.length) await extractTarGzBuffer(agentsTar, home);
        if (credentialPayload?.length) {
          await getLocalExecutor().importCredentials(credentialPayload);
        }
        await finalizeLocalSyncDestination(home, { syncRunId });
        return {
          ok: true,
          files: plan.files.length,
          directories: plan.directories.length,
          deletes: plan.deletes.length,
          totalBytes: plan.totalBytes,
          agentsRoot: plan.agentsRoot ? { fileCount: plan.agentsRoot.fileCount } : null,
          providerCredentials: plan.providerCredentials ? { bytes: plan.providerCredentials.bytes } : null,
          plan,
          ...(magpieResult?.magpieWarnings?.length ? { magpieWarnings: magpieResult.magpieWarnings } : {}),
        };
      }

      const plan = planOpenCodeConfigSync(home, {
        magpie: await getLocalExecutor().magpieInventory(),
        providerCredentials: selections.providerCredentials ? await getLocalExecutor().credentialInventory() : null,
        direction: SYNC_DIRECTION_PUSH,
        syncRunId,
        sourceTargetId: 'local',
        targetId,
        selections,
      });
      const hasPayload = plan.files.length > 0 || plan.directories.length > 0 || Boolean(plan.agentsRoot) || Boolean(plan.providerCredentials) || Boolean(plan.magpie);
      if (!hasPayload) {
        return {
          ok: true,
          files: 0,
          directories: 0,
          deletes: plan.deletes.length,
          totalBytes: 0,
          agentsRoot: null,
          providerCredentials: null,
          plan,
        };
      }

      const wrapped = {
        probe: executor.probe,
        prepare: executor.prepare,
        finalize: executor.finalize,
        putTar: async ({ kind, payload }) => executor.putTar({ kind, payload, syncRunId }),
      };
      try {
        return await applyConfigSyncPlan({
          plan,
          executor: wrapped,
          syncRunId,
          sourceHomedir: home,
          collectTar: collectLocalTarBuffer,
          collectCredentials: () => getLocalExecutor().download('credentials'),
          collectMagpie: () => getLocalExecutor().download('magpie'),
        });
      } catch (error) {
        await executor.abort(syncRunId).catch(() => {});
        throw error;
      }
    });
  };

  const listRuns = async (hostId) => syncRunStore.readAll(syncTargetIdForDirectHost(hostId));

  return { preview, apply, listRuns };
};
