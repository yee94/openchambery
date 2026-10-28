import { describe, expect, it, vi } from 'vitest';
import { trustedGuiPluginClient } from './gui-plugin-source.js';

describe('desktop native GUI code source', () => {
  it.each([
    { managed: true, shared: false, url: 'http://127.0.0.1:4096' },
    { managed: false, shared: true, url: 'http://[::1]:4096' },
  ])('accepts authoritative local ownership: %j', (source) => {
    const value = {}; const client = vi.fn(() => value);
    expect(trustedGuiPluginClient({ ...source, ready: true, client })).toBe(value);
    expect(client).toHaveBeenCalledOnce();
  });
  it.each([
    { managed: false, shared: false, url: 'http://127.0.0.1:4096' },
    { managed: true, shared: false, url: 'https://remote.example' },
    { managed: false, shared: true, url: 'https://localhost.remote.example' },
    { managed: true, shared: false, url: 'file:///plugin.cjs' },
    { managed: true, shared: false, url: 'http://name:password@localhost:4096' },
  ])('rejects external/forwarded or non-local sources before obtaining credentials: %j', (source) => {
    const client = vi.fn();
    expect(() => trustedGuiPluginClient({ ...source, ready: true, client })).toThrow(expect.objectContaining({ code: 'GUI_PLUGIN_UNTRUSTED_SOURCE' }));
    expect(client).not.toHaveBeenCalled();
  });
  it('distinguishes temporarily unavailable local service from an untrusted source', () => {
    expect(() => trustedGuiPluginClient({ managed: true, ready: false, url: 'http://localhost:4096', client: vi.fn() }))
      .toThrow(expect.objectContaining({ code: 'GUI_PLUGIN_UNAVAILABLE' }));
  });
});
