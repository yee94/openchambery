import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRemoteClientAuthRuntime } from './remote-clients.js';

const createRuntime = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-remote-clients-test-'));
  const runtime = createRemoteClientAuthRuntime({
    fsPromises: fs,
    path,
    crypto,
    storePath: path.join(dir, 'remote-clients.json'),
  });
  return { dir, runtime };
};

describe('remote client auth runtime', () => {
  it('persists renamed labels without changing credentials, metadata or revocation', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Phone', devicePlatform: 'iOS', usesRelay: true });
      const renamed = await runtime.renameClient(created.client.id, '  Work phone  ');
      expect(renamed).toEqual({ ...created.client, label: 'Work phone' });
      expect('tokenHash' in renamed).toBe(false);
      const reopened = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(dir, 'remote-clients.json') });
      expect(await reopened.listClients()).toEqual([renamed]);
      expect((await reopened.authenticateBearerToken(created.token))?.clientId).toBe(created.client.id);
      await Promise.all([
        runtime.renameClient(created.client.id, 'Archived phone'),
        runtime.revokeClient(created.client.id),
      ]);
      expect(await runtime.authenticateBearerToken(created.token)).toBe(null);
      expect((await runtime.listClients())[0]).toMatchObject({ label: 'Archived phone', revokedAt: expect.any(String) });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid labels and failed writes without committing a new name', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Phone' });
      for (const label of [undefined, null, 42, '', '  ', 'x'.repeat(81)]) {
        await expect(runtime.renameClient(created.client.id, label)).rejects.toMatchObject({ status: 400 });
      }
      expect(await runtime.renameClient('missing', 'Name')).toBe(null);
      const failing = createRemoteClientAuthRuntime({
        fsPromises: { ...fs, writeFile: async () => { throw new Error('Write failed'); } },
        path, crypto, storePath: path.join(dir, 'remote-clients.json'),
      });
      await expect(failing.renameClient(created.client.id, 'New name')).rejects.toThrow('Write failed');
      expect(await runtime.listClients()).toEqual([created.client]);
      expect((await runtime.authenticateBearerToken(created.token))?.ok).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('creates, authenticates, lists, and revokes client tokens', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Laptop' });
      expect(created.token.startsWith('oc_client_')).toBe(true);
      expect(created.client.label).toBe('Laptop');

      const listed = await runtime.listClients();
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(created.client.id);
      expect('tokenHash' in listed[0]).toBe(false);

      const authenticated = await runtime.authenticateBearerToken(created.token);
      expect(authenticated?.ok).toBe(true);
      expect(authenticated?.clientId).toBe(created.client.id);

      const afterUse = await runtime.listClients();
      expect(typeof afterUse[0].lastUsedAt).toBe('string');

      const revoked = await runtime.revokeClient(created.client.id);
      expect(revoked.revoked).toBe(true);
      expect(await runtime.authenticateBearerToken(created.token)).toBe(null);

      const purged = await runtime.purgeRevokedClients();
      expect(purged.purged).toBe(1);
      expect(await runtime.listClients()).toHaveLength(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects expired client tokens', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const expired = await runtime.createClient({ label: 'Expired', expiresAt: '2000-01-01T00:00:00.000Z' });
      expect(expired.client.expiresAt).toBe('2000-01-01T00:00:00.000Z');
      expect(await runtime.authenticateBearerToken(expired.token)).toBe(null);

      const active = await runtime.createClient({ label: 'Active', expiresAt: '2999-01-01T00:00:00.000Z' });
      const authenticated = await runtime.authenticateBearerToken(active.token);
      expect(authenticated?.ok).toBe(true);
      expect(authenticated?.clientId).toBe(active.client.id);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps one client per dedupe key', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const first = await runtime.createClient({ label: 'Desktop', clientKind: 'desktop-local', dedupeKey: 'desktop-local' });
      const second = await runtime.createClient({ label: 'Desktop', clientKind: 'desktop-local', dedupeKey: 'desktop-local' });

      expect(await runtime.authenticateBearerToken(first.token)).toBe(null);
      const authenticated = await runtime.authenticateBearerToken(second.token);
      expect(authenticated?.ok).toBe(true);

      const listed = await runtime.listClients();
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(second.client.id);
      expect(listed[0].clientKind).toBe('desktop-local');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the token store private on disk', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      await runtime.createClient({ label: 'Laptop' });
      const stat = await fs.stat(path.join(dir, 'remote-clients.json'));
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not resurrect revoked clients after concurrent auth traffic', async () => {
    const { dir, runtime } = await createRuntime();
    try {
      const created = await runtime.createClient({ label: 'Laptop' });
      await Promise.all([
        ...Array.from({ length: 20 }, () => runtime.authenticateBearerToken(created.token)),
        runtime.revokeClient(created.client.id),
      ]);

      expect(await runtime.authenticateBearerToken(created.token)).toBe(null);
      const clients = await runtime.listClients();
      expect(clients).toHaveLength(1);
      expect(typeof clients[0].revokedAt).toBe('string');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
