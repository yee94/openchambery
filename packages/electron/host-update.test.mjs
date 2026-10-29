import { expect, it, vi } from 'vitest';
import { createDesktopUpdateAdapter } from './host-update.mjs';

it.each(['ota', 'installer'])('reuses the existing %s update chain in download-before-restart order', async (kind) => {
  const artifact = { version: '2.1.1' };
  const info = { available: true, version: '2.1.1', manualUpdate: kind === 'installer', body: 'Notes', isChannelRollback: false,
    otaDecision: { native: artifact, ota: { bundle: artifact } } };
  const ota = { check: vi.fn(async () => info), state: { channel: 'beta' } };
  const installer = { check: vi.fn() };
  const calls = [];
  const adapter = createDesktopUpdateAdapter({ getOta: () => ota, getInstaller: () => installer, isSupported: true, isBusy: () => false,
    download: async () => { calls.push('download'); }, restart: async () => { calls.push('restart'); } });
  const release = await adapter.inspect('beta');
  expect(ota.check).toHaveBeenCalledWith('beta', { select: false });
  expect(release).toMatchObject({ kind, version: '2.1.1', releaseNotes: 'Notes' });
  await adapter.execute({ release, channel: 'beta', report: async (patch) => { calls.push(patch.status); } });
  expect(calls).toEqual(['downloading', 'download', 'restarting', 'restart']);
  expect(installer.check).toHaveBeenCalledTimes(kind === 'installer' ? 1 : 0);
});

it('does not restart after a failed download and rejects a competing local download', async () => {
  const info = { available: true, version: '2.1.1', manualUpdate: false, otaDecision: { native: {}, ota: { bundle: {} } } };
  const ota = { check: async () => info, downloadPromise: Promise.resolve() };
  const restart = vi.fn();
  const adapter = createDesktopUpdateAdapter({ getOta: () => ota, getInstaller: () => ({}), isSupported: true, isBusy: () => false,
    download: async () => { throw new Error('offline'); }, restart });
  expect(() => adapter.assertReady()).toThrow('busy');
  const release = await adapter.inspect('stable');
  await expect(adapter.execute({ release, channel: 'stable', report: vi.fn() })).rejects.toThrow('offline');
  expect(restart).not.toHaveBeenCalled();
});
