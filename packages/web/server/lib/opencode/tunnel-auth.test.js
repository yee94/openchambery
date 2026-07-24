import { describe, expect, test } from 'bun:test';

import { createTunnelAuth } from './tunnel-auth.js';

describe('tunnel auth transport policy', () => {
  test('keeps HAPI public origins on ordinary client bearer auth', () => {
    const controller = createTunnelAuth();
    controller.setActiveTunnel({
      tunnelId: 'hapi-1',
      publicUrl: 'https://assigned.relay.example',
      mode: 'quick',
      provider: 'hapi',
    });

    expect(controller.classifyRequestScope({
      hostname: 'assigned.relay.example',
      headers: { host: 'assigned.relay.example' },
      socket: { remoteAddress: '203.0.113.10' },
    })).toBe('local');
    expect(controller.getActiveTunnelProvider()).toBe('hapi');
  });

  test('keeps managed tunnel origins on bootstrap-session auth', () => {
    const controller = createTunnelAuth();
    controller.setActiveTunnel({
      tunnelId: 'managed-1',
      publicUrl: 'https://managed.example',
      mode: 'quick',
      provider: 'cloudflare',
    });

    expect(controller.classifyRequestScope({
      hostname: 'managed.example',
      headers: { host: 'managed.example' },
      socket: { remoteAddress: '203.0.113.10' },
    })).toBe('tunnel');
  });
});
