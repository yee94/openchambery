import { afterEach, describe, expect, test } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCredentialSyncAuthStore } from './credential-sync-auth-store.mjs';
import { createSettingsStore } from './settings-store.mjs';
import { ElectronSshManager } from './ssh-manager.mjs';
import {
  CREDENTIAL_SYNC_UNAUTHORIZED_CODE,
  CredentialSyncUnauthorizedError,
  applyConfigSyncPlan,
  assertCredentialSyncAuthorized,
  planOpenCodeConfigSync,
} from '@openchambery/web/server/lib/config-sync/index.js';
import { isRemoteIpcCommandAllowed } from './ipc-command-gate.mjs';

const tempDirs = [];

const makeTempDir = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-cred-sync-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fsp.rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('credential sync auth store', () => {
  test('isolates grants by targetId and supports revoke', async () => {
    const tempDir = await makeTempDir();
    const settingsStore = createSettingsStore({ filePath: path.join(tempDir, 'settings.json') });
    const store = createCredentialSyncAuthStore({ settingsStore });

    expect(store.getGrantForSshInstance('a').authorized).toBe(false);
    await store.grantForSshInstance('a');
    expect(store.getGrantForSshInstance('a')).toMatchObject({
      authorized: true,
      targetId: 'ssh:a',
      channel: 'instance-settings',
    });
    expect(store.getGrantForSshInstance('b').authorized).toBe(false);

    await store.revokeForSshInstance('a');
    expect(store.getGrantForSshInstance('a').authorized).toBe(false);
  });
});

describe('credential sync enforcement', () => {
  test('assert rejects credential plans without authorization', () => {
    expect(() => assertCredentialSyncAuthorized(
      { authFile: { bytes: 1 }, targetId: 'ssh:x' },
      { targetId: 'ssh:x', authorized: false },
    )).toThrow(CredentialSyncUnauthorizedError);

    try {
      assertCredentialSyncAuthorized(
        { authFile: { bytes: 1 }, targetId: 'ssh:x' },
        { targetId: 'ssh:x', authorized: false },
      );
    } catch (error) {
      expect(error.code).toBe(CREDENTIAL_SYNC_UNAUTHORIZED_CODE);
      expect(error.targetId).toBe('ssh:x');
    }

    expect(() => assertCredentialSyncAuthorized(
      { authFile: { bytes: 1 }, targetId: 'ssh:x' },
      { targetId: 'ssh:x', authorized: true },
    )).not.toThrow();

    expect(() => assertCredentialSyncAuthorized(
      { authFile: null, targetId: 'ssh:x' },
      { targetId: 'ssh:x', authorized: false },
    )).not.toThrow();
  });

  test('plan includeAuthFile false skips auth.json; true includes it', async () => {
    const home = await makeTempDir();
    const shareDir = path.join(home, '.local', 'share', 'opencode');
    const configDir = path.join(home, '.config', 'opencode');
    await fsp.mkdir(shareDir, { recursive: true });
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.writeFile(path.join(configDir, 'AGENTS.md'), 'hi\n');
    await fsp.writeFile(path.join(shareDir, 'auth.json'), '{"token":"x"}\n');

    const skipped = planOpenCodeConfigSync(home, { includeAuthFile: false });
    expect(skipped.authFile).toBeNull();

    const included = planOpenCodeConfigSync(home, { includeAuthFile: true });
    expect(included.authFile).toEqual({ bytes: expect.any(Number) });
  });

  test('applyConfigSyncPlan rejects unauthorized credential plans', async () => {
    const plan = {
      direction: 'push',
      targetId: 'ssh:denied',
      files: [],
      directories: [],
      agentsRoot: null,
      authFile: { bytes: 12 },
      deletes: [],
      totalBytes: 12,
    };
    const executor = {
      probe: async () => ({ remoteExisting: [], remoteAgentsRootExists: false, remoteAuthFileExists: false }),
      prepare: async () => {},
      putTar: async () => {},
      finalize: async () => ({ ok: true }),
    };

    await expect(applyConfigSyncPlan({
      plan,
      executor,
      syncRunId: 'run-1',
      sourceHomedir: os.tmpdir(),
      credentialSyncAuthorized: false,
      collectTar: async () => Buffer.from('x'),
    })).rejects.toMatchObject({ code: CREDENTIAL_SYNC_UNAUTHORIZED_CODE });
  });

  test('manager grant/revoke flips authorization used by preview', async () => {
    const tempDir = await makeTempDir();
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const settingsStore = createSettingsStore({ filePath: settingsFilePath });
    const manager = new ElectronSshManager({
      settingsFilePath,
      settingsStore,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    expect(manager.getCredentialSyncGrant('ssh-1').authorized).toBe(false);
    await manager.grantCredentialSync('ssh-1');
    expect(manager.getCredentialSyncGrant('ssh-1')).toMatchObject({
      authorized: true,
      targetId: 'ssh:ssh-1',
      channel: 'instance-settings',
    });
    await manager.revokeCredentialSync('ssh-1');
    expect(manager.getCredentialSyncGrant('ssh-1').authorized).toBe(false);
  });
});

describe('credential sync IPC gate', () => {
  test('credential sync commands are not remote-safe', () => {
    expect(isRemoteIpcCommandAllowed('desktop_ssh_credential_sync_get')).toBe(false);
    expect(isRemoteIpcCommandAllowed('desktop_ssh_credential_sync_grant')).toBe(false);
    expect(isRemoteIpcCommandAllowed('desktop_ssh_credential_sync_revoke')).toBe(false);
    expect(isRemoteIpcCommandAllowed('desktop_ssh_sync_opencode_config')).toBe(false);
    expect(isRemoteIpcCommandAllowed('desktop_ssh_sync_runs_list')).toBe(false);
  });
});

describe('sync direction options', () => {
  test('normalizeSyncOptions defaults to push and strips auth without grant', async () => {
    const tempDir = await makeTempDir();
    const settingsFilePath = path.join(tempDir, 'settings.json');
    const settingsStore = createSettingsStore({ filePath: settingsFilePath });
    const manager = new ElectronSshManager({
      settingsFilePath,
      settingsStore,
      appVersion: '0.0.0-test',
      emit: () => undefined,
    });

    const normalized = manager.normalizeSyncOptions(
      { direction: 'pull', selections: { authFile: true, agentsRoot: true } },
      { includeAuthFile: false },
    );
    expect(normalized.direction).toBe('pull');
    expect(normalized.selections.authFile).toBe(false);
    expect(normalized.selections.agentsRoot).toBe(true);
  });
});
