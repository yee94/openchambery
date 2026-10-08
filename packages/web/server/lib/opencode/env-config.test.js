import { describe, expect, it, vi } from 'vitest';
import { resolveOpenCodeEnvConfig } from './env-config.js';

describe('explicit OpenCode host ports', () => {
  it.each([
    ['http://example.test:80', 'http://example.test', 80],
    ['https://example.test:443/', 'https://example.test', 443],
    ['http://[::1]:80', 'http://[::1]', 80],
    ['https://[::1]:443', 'https://[::1]', 443],
    ['http://[::1]:4096', 'http://[::1]:4096', 4096],
    ['https://example.test:80', 'https://example.test:80', 80],
  ])('preserves the effective port of %s', (host, origin, port) => {
    const config = resolveOpenCodeEnvConfig({ env: { OPENCODE_HOST: host, OPENCODE_PORT: '1234' } });
    expect(config.configuredOpenCodeHost).toEqual({ origin, port });
    expect(config.effectivePort).toBe(port);
    expect(new URL('/api/info', config.configuredOpenCodeHost.origin).href).toBe(`${origin}/api/info`);
  });

  it.each(['http://example.test', 'https://example.test', 'http://[::1]', 'http://example.test:',
    'ftp://example.test:80', 'http://example.test:80/path', 'http://example.test:80?q=1',
    'http://example.test:80#hash', 'http://example.test:0', 'http://example.test:65536', 'invalid'])('retains rejection of %s', (host) => {
    const logger = { warn: vi.fn() };
    const config = resolveOpenCodeEnvConfig({ env: { OPENCODE_HOST: host, OPENCODE_PORT: '1234' }, logger });
    expect(config.configuredOpenCodeHost).toBeNull();
    expect(config.effectivePort).toBe(1234);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
