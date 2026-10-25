import { describe, expect, it, vi, beforeEach } from 'vitest';

const close = vi.hoisted(() => vi.fn());
const tunnelFetch = vi.hoisted(() => vi.fn());
const invokeDesktop = vi.hoisted(() => vi.fn(async (command: string) => {
  if (command === 'desktop_sync_runs_append') return { ok: true };
  if (command === 'desktop_relay_sync_pack_local') {
    return {
      configTar: new Uint8Array([1, 2, 3]),
      agentsTar: null,
      credentialPayload: null,
    };
  }
  if (command === 'desktop_relay_sync_apply_local') {
    return {
      ok: true,
      files: 1,
      directories: 0,
      deletes: 2,
      totalBytes: 2,
      agentsRoot: null,
      providerCredentials: null,
    };
  }
  return null;
}));
const localScan = vi.hoisted(() => vi.fn(async () => ({
  direction: 'push' as const,
  files: [{ path: 'opencode.jsonc', bytes: 2 }],
  directories: [],
  agentsRoot: null,
  providerCredentials: { bytes: 4 },
  deletes: ['config.json', 'opencode.json'],
  totalBytes: 6,
  selectionShape: { fileGroups: 3, singleFiles: 2, directories: 7 },
})));

vi.mock('@/lib/relay/tunnel-client', () => ({
  createRelayTunnelClient: () => ({
    fetch: tunnelFetch,
    close,
    getStatus: () => ({ state: 'connected' }),
  }),
}));

vi.mock('@/lib/desktop', () => ({
  hasDesktopInvoke: () => true,
  invokeDesktop,
}));

vi.mock('@/lib/desktopSsh', async () => {
  const actual = await vi.importActual<typeof import('@/lib/desktopSsh')>('@/lib/desktopSsh');
  return {
    ...actual,
    desktopSshSyncOpencodeConfigLocalScan: localScan,
  };
});

import {
  RELAY_IDENTITY_CHANGED_CODE,
  RelayIdentityChangedError,
  previewRelayConfigSync,
  applyRelayConfigSync,
} from './relay-config-sync';
import { buildDefaultSyncSelections } from '@/lib/desktopSsh';

describe('relay config sync', () => {
  it('uses the actual pull source for Magpie discovery and carries a Magpie-only payload to desktop', async () => {
    const host = {
      id: 'magpie-host', label: 'Magpie', url: 'relay://srv_magpie', clientToken: 'fixture-token',
      relay: { relayUrl: 'wss://relay.example/ws', serverId: 'srv_magpie', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } },
    };
    const selections = { fileGroups: [false, false, false], singleFiles: [false, false], directories: Array(7).fill(false),
      agentsRoot: false, providerCredentials: false, magpie: false };
    tunnelFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/download/magpie')) return new Response(new Uint8Array([7, 8, 9]));
      return Response.json({ remoteExisting: [], inventory: {
        files: [], directories: [], agentsRoot: null, providerCredentials: null,
        magpie: { available: true, installed: true },
      } });
    });
    const push = await previewRelayConfigSync(host, { direction: 'push', selections });
    expect(push.plan.magpieAvailable).toBeFalsy();
    const pull = await previewRelayConfigSync(host, { direction: 'pull', selections });
    expect(pull.plan.magpieAvailable).toBe(true);
    expect(pull.plan.magpie).toBeNull();
    await applyRelayConfigSync(host, { direction: 'pull', selections: { ...selections, magpie: true } });
    expect(invokeDesktop).toHaveBeenCalledWith('desktop_relay_sync_apply_local', expect.objectContaining({
      magpiePayload: new Uint8Array([7, 8, 9]), plan: expect.objectContaining({ magpie: { bytes: 0 } }),
    }));
  });

  beforeEach(() => {
    close.mockReset();
    tunnelFetch.mockReset();
    invokeDesktop.mockClear();
    localScan.mockClear();
  });

  it('rejects when refreshed serverId differs', async () => {
    await expect(previewRelayConfigSync(
      {
        id: 'h1',
        label: 'Relay',
        url: 'relay://srv_a',
        clientToken: 'tok',
        relay: {
          relayUrl: 'wss://relay.example/ws',
          serverId: 'srv_a',
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
        },
      },
      { direction: 'push' },
      { refreshCandidates: async () => ({ serverId: 'srv_b' }) },
    )).rejects.toMatchObject({ code: RELAY_IDENTITY_CHANGED_CODE });
    expect(RelayIdentityChangedError).toBeTruthy();
  });

  it('probes over the tunnel with bearer auth and skips provider credentials by default', async () => {
    tunnelFetch.mockImplementation(async (path: string) => {
      expect(path).toBe('/api/yuri/config-sync/probe');
      return {
        ok: true,
        json: async () => ({
          remoteExisting: ['opencode.jsonc'],
          remoteAgentsRootExists: false,
          remoteProviderCredentialsExists: false,
          inventory: {
            files: [{ path: 'opencode.jsonc', bytes: 2 }],
            directories: [],
            agentsRoot: null,
            providerCredentials: { bytes: 4 },
          },
        }),
      };
    });

    const preview = await previewRelayConfigSync(
      {
        id: 'h1',
        label: 'Relay',
        url: 'relay://srv_a',
        clientToken: 'tok',
        relay: {
          relayUrl: 'wss://relay.example/ws',
          serverId: 'srv_a',
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
        },
      },
      { direction: 'push' },
      { refreshCandidates: async () => ({ serverId: 'srv_a' }) },
    );

    expect(preview.plan.providerCredentials).toBeNull();
    expect(preview.remoteExisting).toEqual(['opencode.jsonc']);
    expect(preview.selectionShape).toEqual({ fileGroups: 3, singleFiles: 2, directories: 7 });
    expect(close).toHaveBeenCalled();
    expect(tunnelFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    // Shape-first then filtered scan for push.
    expect(localScan).toHaveBeenCalledTimes(2);
  });

  it('includes provider credentials when selected without requiring a grant', async () => {
    tunnelFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        providerCredentials: { bytes: 4 },
        remoteExisting: ['opencode.jsonc'],
        remoteAgentsRootExists: false,
        remoteProviderCredentialsExists: false,
        inventory: {
          files: [{ path: 'opencode.jsonc', bytes: 2 }],
          directories: [],
          agentsRoot: null,
          providerCredentials: { bytes: 4 },
        },
      }),
    }));

    const defaults = buildDefaultSyncSelections({ fileGroups: 3, singleFiles: 2, directories: 7 });
    const preview = await previewRelayConfigSync(
      {
        id: 'h1',
        label: 'Relay',
        url: 'relay://srv_a',
        clientToken: 'tok',
        relay: {
          relayUrl: 'wss://relay.example/ws',
          serverId: 'srv_a',
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
        },
      },
      {
        direction: 'push',
        selections: {
          ...defaults,
          providerCredentials: true,
        },
      },
      { refreshCandidates: async () => ({ serverId: 'srv_a' }) },
    );

    expect(preview.plan.providerCredentials).toEqual({ bytes: 4 });
    expect(close).toHaveBeenCalled();
  });

  it('buildDefaultSyncSelections mirrors selectionShape cardinality', () => {
    const selections = buildDefaultSyncSelections({ fileGroups: 2, singleFiles: 1, directories: 4 }, {
      includeProviderCredentials: true,
    });
    expect(selections.fileGroups).toEqual([true, true]);
    expect(selections.singleFiles).toEqual([true]);
    expect(selections.directories).toEqual([true, true, true, true]);
    expect(selections.agentsRoot).toBe(true);
    expect(selections.providerCredentials).toBe(true);
  });
});
