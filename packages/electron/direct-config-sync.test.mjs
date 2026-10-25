import { describe, expect, test } from 'vitest';

import {
  buildDirectHostAuthHeaders,
  createDirectTargetExecutor,
} from './direct-config-sync.mjs';
import { createDirectHostSyncTarget } from '@yuriai/web/server/lib/config-sync/index.js';
import { isRemoteIpcCommandAllowed } from './ipc-command-gate.mjs';

describe('direct config sync helpers', () => {
  test('builds bearer headers and skips reserved authorization overrides', () => {
    const headers = buildDirectHostAuthHeaders({
      clientToken: 'tok',
      requestHeaders: { Authorization: 'evil', 'X-Test': '1' },
    });
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['X-Test']).toBe('1');
  });

  test('creates host-namespaced direct sync targets with ocHttp capability', () => {
    const target = createDirectHostSyncTarget('abc');
    expect(target).toEqual({
      id: 'host:abc',
      kind: 'direct',
      capabilities: {
        posixShell: false,
        tarExtract: false,
        providerCredentialsWrite: true,
        ocHttp: true,
      },
    });
  });

  test('executor probe posts to the config-sync probe route', async () => {
    /** @type {string[]} */
    const urls = [];
    const fetchImpl = async (url, init) => {
      urls.push(String(url));
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer tok');
      return {
        ok: true,
        json: async () => ({
          remoteExisting: ['opencode.jsonc'],
          remoteAgentsRootExists: false,
          remoteProviderCredentialsExists: false,
          inventory: { files: [{ path: 'opencode.jsonc', bytes: 2 }], directories: [], agentsRoot: null, providerCredentials: null },
        }),
      };
    };

    const executor = createDirectTargetExecutor({
      host: { id: 'h1', apiUrl: 'http://127.0.0.1:3999', clientToken: 'tok' },
      fetchImpl,
    });
    const probe = await executor.probe({ files: [], directories: [], deletes: [] });
    expect(urls[0]).toBe('http://127.0.0.1:3999/api/yuri/config-sync/probe');
    expect(probe.remoteExisting).toEqual(['opencode.jsonc']);
  });

  test('direct sync IPC commands are not remote-safe', () => {
    expect(isRemoteIpcCommandAllowed('desktop_ssh_sync_opencode_config', { targetKind: 'direct' })).toBe(false);
  });

  test('rejects malformed responses instead of reporting a successful credential import', async () => {
    const executor = createDirectTargetExecutor({
      host: { apiUrl: 'https://host.example' },
      fetchImpl: async () => new Response('<html>old host</html>'),
    });
    await expect(executor.credentialInventory()).rejects.toThrow('Invalid provider credential inventory');
    await expect(executor.importCredentials(Buffer.from('{}'))).rejects.toThrow('failed');
  });
});
