import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerDesktopHostRoutes } from './routes.js';

const baseSettings = {
  desktopSshInstances: [{ id: 'ssh-1' }, { id: 'ssh-2' }],
  desktopHosts: [
    { id: 'ssh-1', clientToken: 'ssh-token-1' },
    { id: 'ssh-2', clientToken: 'ssh-token-2' },
    { id: 'lan-other', clientToken: 'other-token' },
  ],
};

const createApp = ({
  settings = baseSettings,
  getSshRoutingTable = () => [],
  getPairingSession,
  mintSshHostToken,
  logger = { warn: vi.fn(), error: vi.fn() },
} = {}) => {
  const app = express();
  registerDesktopHostRoutes(app, {
    express,
    readSettingsFromDiskMigrated: async () => settings,
    getSshRoutingTable,
    getPairingSession,
    mintSshHostToken,
    logger,
  });
  return { app, logger };
};

describe('desktop host routes', () => {
  it('lists SSH hosts with reachable from the routing table and never returns clientToken', async () => {
    const { app } = createApp({
      settings: {
        desktopSshInstances: [
          { id: 'ssh-1', nickname: 'Remote A', localForward: { preferredLocalPort: 41001 } },
          { id: 'ssh-2', nickname: 'Remote B', localForward: { preferredLocalPort: 41002 } },
        ],
        desktopHosts: [
          { id: 'ssh-1', label: 'Remote A', clientToken: 'secret-a' },
          { id: 'ssh-2', label: 'Remote B', clientToken: 'secret-b' },
          { id: 'lan-other', label: 'Other', clientToken: 'secret-other' },
        ],
      },
      getSshRoutingTable: () => [{ id: 'ssh-1', localPort: 41234 }],
    });

    const res = await request(app).get('/api/openchamber/desktop-hosts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hosts: [
        { id: 'ssh-1', label: 'Remote A', localPort: 41234, reachable: true },
        { id: 'ssh-2', label: 'Remote B', localPort: 41002, reachable: false },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(JSON.stringify(res.body)).not.toContain('clientToken');
  });

  it('issues token with localPort/reachable when pairingId matches a redeemed session', async () => {
    const getPairingSession = vi.fn(async (id) => {
      if (id !== 'pair_ok') return null;
      return { id: 'pair_ok', sshHostId: 'ssh-1', usedAt: '2026-01-01T00:00:00.000Z' };
    });
    const { app, logger } = createApp({
      getSshRoutingTable: () => [{ id: 'ssh-1', localPort: 41234 }],
      getPairingSession,
    });

    const ok = await request(app)
      .post('/api/openchamber/ssh-host-token')
      .send({ hostId: 'ssh-1', pairingId: 'pair_ok' });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body).toEqual({
      token: 'ssh-token-1',
      localPort: 41234,
      reachable: true,
    });
    expect(getPairingSession).toHaveBeenCalledWith('pair_ok');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns 403 when pairingId sshHostId does not match hostId', async () => {
    const { app } = createApp({
      getPairingSession: async () => ({
        id: 'pair_x',
        sshHostId: 'ssh-2',
        usedAt: '2026-01-01T00:00:00.000Z',
      }),
    });

    const res = await request(app)
      .post('/api/openchamber/ssh-host-token')
      .send({ hostId: 'ssh-1', pairingId: 'pair_x' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'pairing-mismatch' });
  });

  it('returns 403 when pairing session is not redeemed', async () => {
    const { app } = createApp({
      getPairingSession: async () => ({
        id: 'pair_pending',
        sshHostId: 'ssh-1',
        usedAt: null,
      }),
    });

    const res = await request(app)
      .post('/api/openchamber/ssh-host-token')
      .send({ hostId: 'ssh-1', pairingId: 'pair_pending' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'pairing-mismatch' });
  });

  it('returns 403 when pairingId is unknown', async () => {
    const { app } = createApp({
      getPairingSession: async () => null,
    });

    const res = await request(app)
      .post('/api/openchamber/ssh-host-token')
      .send({ hostId: 'ssh-1', pairingId: 'pair_missing' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'pairing-mismatch' });
  });

  it('allows legacy mint without pairingId and logs a deprecation warning', async () => {
    const { app, logger } = createApp({
      getSshRoutingTable: () => [{ id: 'ssh-1', localPort: 41234 }],
    });

    const ok = await request(app)
      .post('/api/openchamber/ssh-host-token')
      .send({ hostId: 'ssh-1' });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body).toEqual({
      token: 'ssh-token-1',
      localPort: 41234,
      reachable: true,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toMatch(/deprecated/i);
  });

  it('returns reachable false and localPort null when routing table misses', async () => {
    const { app } = createApp({
      getSshRoutingTable: () => [],
      getPairingSession: async () => ({
        id: 'pair_ok',
        sshHostId: 'ssh-1',
        usedAt: '2026-01-01T00:00:00.000Z',
      }),
    });

    const res = await request(app)
      .post('/api/openchamber/ssh-host-token')
      .send({ hostId: 'ssh-1', pairingId: 'pair_ok' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      token: 'ssh-token-1',
      localPort: null,
      reachable: false,
    });
  });

  it('returns 404 for missing / non-SSH / tokenless hosts', async () => {
    const { app } = createApp();

    const missing = await request(app)
      .post('/api/openchamber/ssh-host-token')
      .send({ hostId: 'missing' });
    expect(missing.status).toBe(404);

    const nonSsh = await request(app)
      .post('/api/openchamber/ssh-host-token')
      .send({ hostId: 'lan-other' });
    expect(nonSsh.status).toBe(404);

    const { app: noTokenApp } = createApp({
      settings: {
        desktopSshInstances: [{ id: 'ssh-empty' }],
        desktopHosts: [{ id: 'ssh-empty' }],
      },
    });
    const noToken = await request(noTokenApp)
      .post('/api/openchamber/ssh-host-token')
      .send({ hostId: 'ssh-empty' });
    expect(noToken.status).toBe(404);
  });

  it('mints a token on demand when the stored SSH host is tokenless', async () => {
    const mintSshHostToken = vi.fn(async (hostId) => {
      expect(hostId).toBe('ssh-empty');
      return 'minted-on-demand';
    });
    const { app } = createApp({
      settings: {
        desktopSshInstances: [{ id: 'ssh-empty' }],
        desktopHosts: [{ id: 'ssh-empty' }],
      },
      getSshRoutingTable: () => [{ id: 'ssh-empty', localPort: 41234 }],
      getPairingSession: async () => ({
        id: 'pair_ok',
        sshHostId: 'ssh-empty',
        usedAt: '2026-01-01T00:00:00.000Z',
      }),
      mintSshHostToken,
    });

    const res = await request(app)
      .post('/api/openchamber/ssh-host-token')
      .send({ hostId: 'ssh-empty', pairingId: 'pair_ok' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      token: 'minted-on-demand',
      localPort: 41234,
      reachable: true,
    });
    expect(mintSshHostToken).toHaveBeenCalledWith('ssh-empty');
  });
});
