import { describe, expect, test } from 'vitest';

import {
  buildDirectHostAuthHeaders,
  createDirectTargetExecutor,
} from './direct-config-sync.mjs';
import { createDirectHostSyncTarget } from '@openchambery/web/server/lib/config-sync/index.js';
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
        authFileWrite: true,
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
          remoteAuthFileExists: false,
          inventory: { files: [{ path: 'opencode.jsonc', bytes: 2 }], directories: [], agentsRoot: null, authFile: null },
        }),
      };
    };

    const executor = createDirectTargetExecutor({
      host: { id: 'h1', apiUrl: 'http://127.0.0.1:3999', clientToken: 'tok' },
      fetchImpl,
    });
    const probe = await executor.probe({ files: [], directories: [], deletes: [] });
    expect(urls[0]).toBe('http://127.0.0.1:3999/api/openchamber/config-sync/probe');
    expect(probe.remoteExisting).toEqual(['opencode.jsonc']);
  });

  test('direct sync IPC commands are not remote-safe', () => {
    expect(isRemoteIpcCommandAllowed('desktop_ssh_sync_opencode_config', { targetKind: 'direct' })).toBe(false);
  });
});
