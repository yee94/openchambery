/**
 * Relay-backed OpenCode config sync.
 *
 * Tunnel clients live in the UI process; Electron main cannot open E2EE tunnels.
 * This module runs probe/prepare/put/download/finalize over `tunnel.fetch`, while
 * credential grants and sync-run records stay in Electron IPC (`relay:<serverId>`).
 *
 * Identity gate: every preview/apply refreshes candidates (when a refresh hook is
 * provided) and refuses to continue if `serverId` changed (`relay_identity_changed`).
 */
import {
  createRelayTunnelClient,
  type RelayTunnelClient,
} from '@/lib/relay/tunnel-client';
import type { DesktopHost, DesktopHostRelay } from '@/lib/desktopHosts';
import {
  desktopSshCredentialSyncGet,
  desktopSshSyncOpencodeConfigLocalScan,
  type DesktopSshConfigSyncDirection,
  type DesktopSshConfigSyncOptions,
  type DesktopSshConfigSyncPlan,
  type DesktopSshConfigSyncPreview,
  type DesktopSshConfigSyncResult,
  type DesktopSshConfigSyncSelections,
} from '@/lib/desktopSsh';
import { hasDesktopInvoke, invokeDesktop } from '@/lib/desktop';

export const RELAY_IDENTITY_CHANGED_CODE = 'relay_identity_changed';

export class RelayIdentityChangedError extends Error {
  readonly code = RELAY_IDENTITY_CHANGED_CODE;
  readonly expectedServerId: string;
  readonly actualServerId?: string;

  constructor(expectedServerId: string, actualServerId?: string) {
    super(
      `Relay identity changed (expected ${expectedServerId}, got ${actualServerId || 'unknown'})`,
    );
    this.name = 'RelayIdentityChangedError';
    this.expectedServerId = expectedServerId;
    this.actualServerId = actualServerId;
  }
}

type SyncRunAppendRecord = {
  syncRunId: string;
  targetId: string;
  stage: 'preview' | 'apply';
  direction: DesktopSshConfigSyncDirection;
  startedAt: string;
  endedAt: string;
  result: 'success' | 'failure';
  summary?: { files: number; directories: number; deletes: number; totalBytes: number };
  error?: string;
};

const inflightByTarget = new Map<string, string>();

const syncTargetIdForRelayServer = (serverId: string): string => {
  const id = serverId.trim();
  if (!id) throw new Error('Relay serverId is required');
  return `relay:${id}`;
};

const buildAuthHeaders = (host: DesktopHost): Record<string, string> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = typeof host.clientToken === 'string' ? host.clientToken.trim() : '';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (host.requestHeaders) {
    for (const [key, value] of Object.entries(host.requestHeaders)) {
      if (!key.trim() || !value.trim()) continue;
      if (key.trim().toLowerCase() === 'authorization') continue;
      headers[key.trim()] = value.trim();
    }
  }
  return headers;
};

const summarizePlan = (plan: DesktopSshConfigSyncPlan | null | undefined) => ({
  files: plan?.files?.length ?? 0,
  directories: plan?.directories?.length ?? 0,
  deletes: plan?.deletes?.length ?? 0,
  totalBytes: plan?.totalBytes ?? 0,
});

const appendSyncRun = async (record: SyncRunAppendRecord): Promise<void> => {
  if (!hasDesktopInvoke()) return;
  await invokeDesktop('desktop_sync_runs_append', { record });
};

const assertRelayIdentity = async (
  expectedServerId: string,
  refreshCandidates?: () => Promise<{ serverId?: string } | null>,
): Promise<void> => {
  if (!refreshCandidates) return;
  const refreshed = await refreshCandidates().catch(() => null);
  const actual = typeof refreshed?.serverId === 'string' ? refreshed.serverId.trim() : '';
  if (actual && actual !== expectedServerId) {
    throw new RelayIdentityChangedError(expectedServerId, actual);
  }
};

type RelayExecutor = {
  tunnel: RelayTunnelClient;
  probe: (plan: object) => Promise<{
    remoteExisting: string[];
    remoteAgentsRootExists: boolean;
    remoteAuthFileExists: boolean;
    inventory?: unknown;
    inboundCredentialAuthorized?: boolean;
  }>;
  prepare: (plan: object, syncRunId: string) => Promise<void>;
  putTar: (kind: 'config' | 'agents' | 'auth', payload: Uint8Array, syncRunId: string) => Promise<void>;
  download: (kind: 'config' | 'agents' | 'auth') => Promise<Uint8Array>;
  finalize: (syncRunId: string) => Promise<void>;
  abort: (syncRunId: string) => Promise<void>;
  close: () => void;
};

const createRelayHttpExecutor = (
  relay: DesktopHostRelay,
  host: DesktopHost,
): RelayExecutor => {
  const tunnel = createRelayTunnelClient({
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
  });
  const headers = buildAuthHeaders(host);

  const jsonFetch = async (method: string, path: string, body?: unknown) => {
    const response = await tunnel.fetch(path, {
      method,
      headers: {
        ...headers,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = new Error(
        typeof payload.error === 'string'
          ? payload.error
          : `Relay sync ${method} ${path} failed (${response.status})`,
      );
      if (typeof payload.code === 'string') {
        (error as Error & { code?: string }).code = payload.code;
      }
      throw error;
    }
    return payload;
  };

  return {
    tunnel,
    async probe(plan) {
      const result = await jsonFetch('POST', '/api/openchamber/config-sync/probe', { plan });
      return {
        remoteExisting: Array.isArray(result.remoteExisting) ? result.remoteExisting as string[] : [],
        remoteAgentsRootExists: result.remoteAgentsRootExists === true,
        remoteAuthFileExists: result.remoteAuthFileExists === true,
        inventory: result.inventory,
        inboundCredentialAuthorized: result.inboundCredentialAuthorized === true,
      };
    },
    async prepare(plan, syncRunId) {
      await jsonFetch('POST', '/api/openchamber/config-sync/prepare', { plan, syncRunId });
    },
    async putTar(kind, payload, syncRunId) {
      const response = await tunnel.fetch(
        `/api/openchamber/config-sync/put/${encodeURIComponent(kind)}?syncRunId=${encodeURIComponent(syncRunId)}`,
        {
          method: 'PUT',
          headers: {
            ...headers,
            'Content-Type': 'application/gzip',
          },
          body: new Blob([new Uint8Array(payload)], { type: 'application/gzip' }),
        },
      );
      const payloadJson = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const error = new Error(
          typeof payloadJson.error === 'string'
            ? payloadJson.error
            : `Relay sync put ${kind} failed (${response.status})`,
        );
        if (typeof payloadJson.code === 'string') {
          (error as Error & { code?: string }).code = payloadJson.code;
        }
        throw error;
      }
    },
    async download(kind) {
      const response = await tunnel.fetch(
        `/api/openchamber/config-sync/download/${encodeURIComponent(kind)}`,
        { method: 'GET', headers },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        const error = new Error(
          typeof payload.error === 'string'
            ? payload.error
            : `Relay sync download ${kind} failed (${response.status})`,
        );
        if (typeof payload.code === 'string') {
          (error as Error & { code?: string }).code = payload.code;
        }
        throw error;
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async finalize(syncRunId) {
      await jsonFetch('POST', '/api/openchamber/config-sync/finalize', { syncRunId });
    },
    async abort(syncRunId) {
      await jsonFetch('POST', '/api/openchamber/config-sync/abort', { syncRunId }).catch(() => undefined);
    },
    close() {
      tunnel.close();
    },
  };
};

const runExclusive = async <T,>(
  targetId: string,
  stage: 'preview' | 'apply',
  direction: DesktopSshConfigSyncDirection,
  work: (ctx: { syncRunId: string }) => Promise<T & { plan?: DesktopSshConfigSyncPlan }>,
): Promise<T & { syncRunId: string }> => {
  if (inflightByTarget.has(targetId)) {
    const error = new Error(`Config sync already in progress for ${targetId}`);
    (error as Error & { code?: string }).code = 'sync_in_progress';
    throw error;
  }
  const syncRunId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  inflightByTarget.set(targetId, syncRunId);
  try {
    const result = await work({ syncRunId });
    await appendSyncRun({
      syncRunId,
      targetId,
      stage,
      direction,
      startedAt,
      endedAt: new Date().toISOString(),
      result: 'success',
      summary: summarizePlan(result.plan),
    });
    // Keep `plan` on preview/apply results — the wizard reviews it before confirm.
    return { ...result, syncRunId };
  } catch (error) {
    await appendSyncRun({
      syncRunId,
      targetId,
      stage,
      direction,
      startedAt,
      endedAt: new Date().toISOString(),
      result: 'failure',
      summary: summarizePlan(null),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  } finally {
    if (inflightByTarget.get(targetId) === syncRunId) {
      inflightByTarget.delete(targetId);
    }
  }
};

export type RelayConfigSyncHost = DesktopHost & { relay: DesktopHostRelay };

export type RelayConfigSyncHooks = {
  /** Optional candidate refresh; must return the same serverId or identity gate fails. */
  refreshCandidates?: () => Promise<{ serverId?: string } | null>;
};

/**
 * Preview relay config sync. Opens a throwaway tunnel (or uses hooks) and never
 * writes on either side.
 */
export const previewRelayConfigSync = async (
  host: RelayConfigSyncHost,
  options: DesktopSshConfigSyncOptions = {},
  hooks: RelayConfigSyncHooks = {},
): Promise<DesktopSshConfigSyncPreview & { syncRunId: string }> => {
  const relay = host.relay;
  const targetId = syncTargetIdForRelayServer(relay.serverId);
  const direction: DesktopSshConfigSyncDirection = options.direction === 'pull' ? 'pull' : 'push';
  const grant = await desktopSshCredentialSyncGet(relay.serverId, { targetKind: 'relay' });
  const credentialAuthorized = grant?.authorized === true;
  const selections: DesktopSshConfigSyncSelections = {
    fileGroups: options.selections?.fileGroups ?? [true, true, true],
    singleFiles: options.selections?.singleFiles ?? [true, true],
    directories: options.selections?.directories ?? [true, true, true, true, true, true, true],
    agentsRoot: options.selections?.agentsRoot !== false,
    authFile: credentialAuthorized && options.selections?.authFile === true,
  };

  return runExclusive(targetId, 'preview', direction, async () => {
    await assertRelayIdentity(relay.serverId, hooks.refreshCandidates);
    const executor = createRelayHttpExecutor(relay, host);
    try {
      if (direction === 'pull') {
        const probe = await executor.probe({});
        // Pull plan is computed on the remote inventory via the server response;
        // local scan still seeds allowlist shape for the wizard.
        const localPlan = await desktopSshSyncOpencodeConfigLocalScan({
          direction: 'pull',
          selections,
          targetKind: 'relay',
        });
        const inventory = (probe.inventory && typeof probe.inventory === 'object')
          ? probe.inventory as {
            files?: DesktopSshConfigSyncPlan['files'];
            directories?: DesktopSshConfigSyncPlan['directories'];
            agentsRoot?: DesktopSshConfigSyncPlan['agentsRoot'];
            authFile?: DesktopSshConfigSyncPlan['authFile'];
          }
          : null;
        const plan: DesktopSshConfigSyncPlan = {
          direction: 'pull',
          files: inventory?.files ?? localPlan?.files ?? [],
          directories: inventory?.directories ?? localPlan?.directories ?? [],
          agentsRoot: selections.agentsRoot ? (inventory?.agentsRoot ?? null) : null,
          authFile: selections.authFile ? (inventory?.authFile ?? null) : null,
          deletes: localPlan?.deletes ?? [],
          totalBytes: localPlan?.totalBytes ?? 0,
          selections,
        };
        if (plan.authFile && !credentialAuthorized) {
          const error = new Error(`Credential sync is not authorized for ${targetId}`);
          (error as Error & { code?: string }).code = 'credential_sync_unauthorized';
          throw error;
        }
        return {
          plan,
          remoteExisting: probe.remoteExisting,
          remoteAgentsRootExists: probe.remoteAgentsRootExists,
          remoteAuthFileExists: probe.remoteAuthFileExists,
          credentialAuthorized,
        };
      }

      const localPlan = await desktopSshSyncOpencodeConfigLocalScan({
        direction: 'push',
        selections,
        targetKind: 'relay',
      });
      if (!localPlan) {
        throw new Error('Local sync inventory unavailable');
      }
      const plan: DesktopSshConfigSyncPlan = {
        ...localPlan,
        direction: 'push',
        authFile: selections.authFile ? localPlan.authFile : null,
        agentsRoot: selections.agentsRoot ? localPlan.agentsRoot : null,
        selections,
      };
      if (plan.authFile && !credentialAuthorized) {
        const error = new Error(`Credential sync is not authorized for ${targetId}`);
        (error as Error & { code?: string }).code = 'credential_sync_unauthorized';
        throw error;
      }
      const probe = await executor.probe(plan);
      return {
        plan,
        remoteExisting: probe.remoteExisting,
        remoteAgentsRootExists: probe.remoteAgentsRootExists,
        remoteAuthFileExists: probe.remoteAuthFileExists,
        credentialAuthorized,
      };
    } finally {
      executor.close();
    }
  });
};

/**
 * Apply relay config sync. On tunnel/identity failure, aborts remote inflight
 * when possible and records failure.
 */
export const applyRelayConfigSync = async (
  host: RelayConfigSyncHost,
  options: DesktopSshConfigSyncOptions = {},
  hooks: RelayConfigSyncHooks = {},
): Promise<DesktopSshConfigSyncResult & { syncRunId: string }> => {
  const relay = host.relay;
  const targetId = syncTargetIdForRelayServer(relay.serverId);
  const direction: DesktopSshConfigSyncDirection = options.direction === 'pull' ? 'pull' : 'push';
  const grant = await desktopSshCredentialSyncGet(relay.serverId, { targetKind: 'relay' });
  const credentialAuthorized = grant?.authorized === true;
  const selections = options.selections ?? {
    fileGroups: [true, true, true],
    singleFiles: [true, true],
    directories: [true, true, true, true, true, true, true],
    agentsRoot: true,
    authFile: false,
  };
  if (!credentialAuthorized) {
    selections.authFile = false;
  }

  return runExclusive(targetId, 'apply', direction, async ({ syncRunId }) => {
    await assertRelayIdentity(relay.serverId, hooks.refreshCandidates);
    const executor = createRelayHttpExecutor(relay, host);
    try {
      // Apply is executed by Electron for SSH/direct; for relay we drive the HTTP
      // protocol here and let the remote receiver mutate. Pull downloads are
      // applied locally through a dedicated Electron helper when available.
      if (direction === 'pull') {
        // Pull apply: probe inventory over the tunnel, download tars, then hand
        // bytes to Electron for local extract (main owns local-backup helpers).
        // Do NOT call previewRelayConfigSync here — it would re-enter the mutex.
        const probe = await executor.probe({});
        const localPlan = await desktopSshSyncOpencodeConfigLocalScan({
          direction: 'pull',
          selections,
          targetKind: 'relay',
        });
        const inventory = (probe.inventory && typeof probe.inventory === 'object')
          ? probe.inventory as {
            files?: DesktopSshConfigSyncPlan['files'];
            directories?: DesktopSshConfigSyncPlan['directories'];
            agentsRoot?: DesktopSshConfigSyncPlan['agentsRoot'];
            authFile?: DesktopSshConfigSyncPlan['authFile'];
          }
          : null;
        const plan: DesktopSshConfigSyncPlan = {
          direction: 'pull',
          files: inventory?.files ?? localPlan?.files ?? [],
          directories: inventory?.directories ?? localPlan?.directories ?? [],
          agentsRoot: selections.agentsRoot ? (inventory?.agentsRoot ?? null) : null,
          authFile: selections.authFile ? (inventory?.authFile ?? null) : null,
          deletes: localPlan?.deletes ?? [],
          totalBytes: localPlan?.totalBytes ?? 0,
          selections,
        };
        if (plan.authFile && !credentialAuthorized) {
          const error = new Error(`Credential sync is not authorized for ${targetId}`);
          (error as Error & { code?: string }).code = 'credential_sync_unauthorized';
          throw error;
        }
        const hasPayload = plan.files.length > 0
          || plan.directories.length > 0
          || Boolean(plan.agentsRoot)
          || Boolean(plan.authFile);
        if (!hasPayload) {
          return {
            ok: true as const,
            files: 0,
            directories: 0,
            deletes: plan.deletes.length,
            totalBytes: 0,
            agentsRoot: null,
            authFile: null,
            plan,
          };
        }
        const configTar = (plan.files.length > 0 || plan.directories.length > 0)
          ? await executor.download('config')
          : null;
        const agentsTar = plan.agentsRoot ? await executor.download('agents') : null;
        const authTar = plan.authFile ? await executor.download('auth') : null;
        if (!hasDesktopInvoke()) {
          throw new Error('Relay pull apply requires the OpenChamber desktop app');
        }
        const applied = await invokeDesktop('desktop_relay_sync_apply_local', {
          syncRunId,
          plan,
          configTar: configTar ? Array.from(configTar) : null,
          agentsTar: agentsTar ? Array.from(agentsTar) : null,
          authTar: authTar ? Array.from(authTar) : null,
        }) as DesktopSshConfigSyncResult | null;
        if (!applied?.ok) {
          throw new Error('Relay pull local apply failed');
        }
        return { ...applied, plan };
      }

      const localPlan = await desktopSshSyncOpencodeConfigLocalScan({
        direction: 'push',
        selections,
        targetKind: 'relay',
      });
      if (!localPlan) throw new Error('Local sync inventory unavailable');
      const plan: DesktopSshConfigSyncPlan = {
        ...localPlan,
        direction: 'push',
        authFile: selections.authFile ? localPlan.authFile : null,
        agentsRoot: selections.agentsRoot ? localPlan.agentsRoot : null,
        selections,
      };
      if (plan.authFile && !credentialAuthorized) {
        const error = new Error(`Credential sync is not authorized for ${targetId}`);
        (error as Error & { code?: string }).code = 'credential_sync_unauthorized';
        throw error;
      }
      const hasPayload = plan.files.length > 0
        || plan.directories.length > 0
        || Boolean(plan.agentsRoot)
        || Boolean(plan.authFile);
      if (!hasPayload) {
        return {
          ok: true as const,
          files: 0,
          directories: 0,
          deletes: plan.deletes.length,
          totalBytes: 0,
          agentsRoot: null,
          authFile: null,
          plan,
        };
      }

      // Collect local tars in Electron, then stream put over the tunnel.
      if (!hasDesktopInvoke()) {
        throw new Error('Relay push apply requires the OpenChamber desktop app');
      }
      const packed = await invokeDesktop('desktop_relay_sync_pack_local', {
        plan,
      }) as {
        configTar?: number[] | null;
        agentsTar?: number[] | null;
        authTar?: number[] | null;
      } | null;
      if (!packed) throw new Error('Relay push local pack failed');

      await executor.prepare(plan, syncRunId);
      try {
        if (packed.configTar?.length) {
          await executor.putTar('config', Uint8Array.from(packed.configTar), syncRunId);
        }
        if (packed.agentsTar?.length) {
          await executor.putTar('agents', Uint8Array.from(packed.agentsTar), syncRunId);
        }
        if (packed.authTar?.length) {
          await executor.putTar('auth', Uint8Array.from(packed.authTar), syncRunId);
        }
        await executor.finalize(syncRunId);
      } catch (error) {
        await executor.abort(syncRunId);
        throw error;
      }

      return {
        ok: true as const,
        files: plan.files.length,
        directories: plan.directories.length,
        deletes: plan.deletes.length,
        totalBytes: plan.totalBytes,
        agentsRoot: plan.agentsRoot ? { fileCount: plan.agentsRoot.fileCount } : null,
        authFile: plan.authFile ? { bytes: plan.authFile.bytes } : null,
        plan,
      };
    } finally {
      executor.close();
    }
  });
};
