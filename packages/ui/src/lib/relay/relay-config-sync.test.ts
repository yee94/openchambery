import { describe, expect, it, vi, beforeEach } from 'vitest';

const close = vi.hoisted(() => vi.fn());
const tunnelFetch = vi.hoisted(() => vi.fn());
const invokeDesktop = vi.hoisted(() => vi.fn(async (command: string) => {
  if (command === 'desktop_sync_runs_append') return { ok: true };
  if (command === 'desktop_relay_sync_pack_local') {
    return {
      configTar: new Uint8Array([1, 2, 3]),
      agentsTar: null,
      authTar: null,
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
      authFile: null,
    };
  }
  return null;
}));
const localScan = vi.hoisted(() => vi.fn(async () => ({
  direction: 'push' as const,
  files: [{ path: 'opencode.jsonc', bytes: 2 }],
  directories: [],
  agentsRoot: null,
  authFile: { bytes: 4 },
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
} from './relay-config-sync';
import { buildDefaultSyncSelections } from '@/lib/desktopSsh';

describe('relay config sync', () => {
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

  it('probes over the tunnel with bearer auth and skips authFile by default', async () => {
    tunnelFetch.mockImplementation(async (path: string) => {
      expect(path).toBe('/api/openchamber/config-sync/probe');
      return {
        ok: true,
        json: async () => ({
          remoteExisting: ['opencode.jsonc'],
          remoteAgentsRootExists: false,
          remoteAuthFileExists: false,
          inventory: {
            files: [{ path: 'opencode.jsonc', bytes: 2 }],
            directories: [],
            agentsRoot: null,
            authFile: { bytes: 4 },
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

    expect(preview.plan.authFile).toBeNull();
    expect(preview.remoteExisting).toEqual(['opencode.jsonc']);
    expect(preview.selectionShape).toEqual({ fileGroups: 3, singleFiles: 2, directories: 7 });
    expect(close).toHaveBeenCalled();
    expect(tunnelFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    // Shape-first then filtered scan for push.
    expect(localScan).toHaveBeenCalledTimes(2);
  });

  it('includes authFile when selections.authFile is true without requiring a grant', async () => {
    tunnelFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        remoteExisting: ['opencode.jsonc'],
        remoteAgentsRootExists: false,
        remoteAuthFileExists: false,
        inventory: {
          files: [{ path: 'opencode.jsonc', bytes: 2 }],
          directories: [],
          agentsRoot: null,
          authFile: { bytes: 4 },
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
          authFile: true,
        },
      },
      { refreshCandidates: async () => ({ serverId: 'srv_a' }) },
    );

    expect(preview.plan.authFile).toEqual({ bytes: 4 });
    expect(close).toHaveBeenCalled();
  });

  it('buildDefaultSyncSelections mirrors selectionShape cardinality', () => {
    const selections = buildDefaultSyncSelections({ fileGroups: 2, singleFiles: 1, directories: 4 }, {
      includeAuthFile: true,
    });
    expect(selections.fileGroups).toEqual([true, true]);
    expect(selections.singleFiles).toEqual([true]);
    expect(selections.directories).toEqual([true, true, true, true]);
    expect(selections.agentsRoot).toBe(true);
    expect(selections.authFile).toBe(true);
  });
});
