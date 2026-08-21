import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  RELAY_IDENTITY_CHANGED_CODE,
  RelayIdentityChangedError,
  previewRelayConfigSync,
} from './relay-config-sync';

const close = vi.fn();
const tunnelFetch = vi.fn();

vi.mock('@/lib/relay/tunnel-client', () => ({
  createRelayTunnelClient: () => ({
    fetch: tunnelFetch,
    close,
    getStatus: () => ({ state: 'connected' }),
  }),
}));

vi.mock('@/lib/desktop', () => ({
  hasDesktopInvoke: () => true,
  invokeDesktop: vi.fn(async (command: string) => {
    if (command === 'desktop_sync_runs_append') return { ok: true };
    return null;
  }),
}));

vi.mock('@/lib/desktopSsh', () => ({
  desktopSshCredentialSyncGet: vi.fn(async () => ({ targetId: 'relay:srv', authorized: false })),
  desktopSshSyncOpencodeConfigLocalScan: vi.fn(async () => ({
    direction: 'push',
    files: [{ path: 'opencode.jsonc', bytes: 2 }],
    directories: [],
    agentsRoot: null,
    authFile: { bytes: 4 },
    deletes: ['config.json', 'opencode.json'],
    totalBytes: 6,
  })),
}));

describe('relay config sync', () => {
  beforeEach(() => {
    close.mockReset();
    tunnelFetch.mockReset();
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

  it('probes over the tunnel with bearer auth and skips authFile without grant', async () => {
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
          inboundCredentialAuthorized: false,
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
      {
        direction: 'push',
        selections: {
          fileGroups: [true, true, true],
          singleFiles: [true, true],
          directories: [true, true, true, true, true, true, true],
          agentsRoot: true,
          authFile: true,
        },
      },
      { refreshCandidates: async () => ({ serverId: 'srv_a' }) },
    );

    expect(preview.plan.authFile).toBeNull();
    expect(preview.credentialAuthorized).toBe(false);
    expect(preview.remoteExisting).toEqual(['opencode.jsonc']);
    expect(close).toHaveBeenCalled();
    expect(tunnelFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });
});
