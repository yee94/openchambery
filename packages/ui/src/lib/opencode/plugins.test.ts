import { beforeEach, describe, expect, test, vi } from 'vitest';
import { checkPluginUpdates, listPluginRuntime, updatePluginPackage } from './plugins';

const plugin = vi.hoisted(() => ({
  list: vi.fn(),
  check: vi.fn(),
  update: vi.fn(),
}));

vi.mock('./client', () => ({
  opencodeClient: { getSdkClient: () => ({ plugin }) },
}));

const inventory = {
  data: [
    { source: { type: 'package', target: 'foo', version: '1.0.0', outdated: true }, features: {}, state: { status: 'active' } },
    { source: { type: 'local', path: '/a/bad' }, features: {}, state: { status: 'failed', error: 'Plugin entrypoint not found', ref: 'err_1' } },
    { source: { type: 'builtin' }, features: {}, state: { status: 'active' } },
  ],
};

describe('plugin runtime client', () => {
  beforeEach(() => {
    plugin.list.mockReset();
    plugin.check.mockReset();
    plugin.update.mockReset();
    plugin.list.mockResolvedValue(inventory);
    plugin.check.mockResolvedValue({ data: [] });
    plugin.update.mockResolvedValue(undefined);
  });

  test('list maps OpenCode status and scopes the directory', async () => {
    await expect(listPluginRuntime('/a')).resolves.toEqual([
      { source: { kind: 'package', target: 'foo', version: '1.0.0', outdated: true, updating: false }, state: { kind: 'active' } },
      { source: { kind: 'local', path: '/a/bad' }, state: { kind: 'failed', error: 'Plugin entrypoint not found', ref: 'err_1' } },
      { source: { kind: 'builtin' }, state: { kind: 'active' } },
    ]);
    expect(plugin.list).toHaveBeenCalledWith({ location: { directory: '/a' } }, undefined);
  });

  test('a failed read throws instead of returning an empty inventory', async () => {
    plugin.list.mockRejectedValueOnce(new Error('down'));
    await expect(listPluginRuntime('/a')).rejects.toThrow('down');
  });

  test('an invalid payload is not treated as every plugin loaded', async () => {
    plugin.list.mockResolvedValueOnce({ data: null });
    await expect(listPluginRuntime('/a')).rejects.toThrow('invalid');
  });

  test('update sends one verbatim target and does not rewrite a pin', async () => {
    await updatePluginPackage('/a', 'foo@1.2.3');
    expect(plugin.update).toHaveBeenCalledWith({
      location: { directory: '/a' },
      targets: ['foo@1.2.3'],
    }, undefined);
    expect(plugin.list).not.toHaveBeenCalled();
    expect(plugin.check).not.toHaveBeenCalled();
  });

  test('a failed update keeps the OpenCode error', async () => {
    plugin.update.mockRejectedValueOnce(new Error('Failed to update plugin packages: foo: registry timeout'));
    await expect(updatePluginPackage('/a', 'foo')).rejects.toThrow('registry timeout');
  });

  test('a failed check throws so the caller can keep the inventory on screen', async () => {
    plugin.check.mockRejectedValueOnce(new Error('down'));
    await expect(checkPluginUpdates('/a')).rejects.toThrow('down');
  });
});
