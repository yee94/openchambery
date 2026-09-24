import fs from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import { browserProviderUnsupportedBody, isBrowserProviderRoute } from './browserProviderRoute';

describe('browser provider route', () => {
  test('matches the host paths and not neighboring OpenChamber routes', () => {
    expect(isBrowserProviderRoute('/api/browser-providers')).toBe(true);
    expect(isBrowserProviderRoute('/api/browser-providers/')).toBe(true);
    expect(isBrowserProviderRoute('/api/browser-providers/actions')).toBe(true);
    expect(isBrowserProviderRoute('/api/browser-providers/selection')).toBe(true);
    expect(isBrowserProviderRoute('/api/openchamber/message-queue')).toBe(false);
    expect(isBrowserProviderRoute('/api/browser-providers-other')).toBe(false);
  });

  test('the webview refuses the route before the OpenCode proxy', async () => {
    const source = await fs.readFile(new URL('./main.tsx', import.meta.url), 'utf8');
    expect(source).toContain('isBrowserProviderRoute(normalizedPathname)');
    expect(source).toContain('jsonResponse(browserProviderUnsupportedBody(), 501)');
    const guard = source.indexOf('isBrowserProviderRoute(normalizedPathname)');
    const proxy = source.indexOf('await proxyApiRequest(');
    expect(guard).toBeGreaterThan(-1);
    expect(proxy).toBeGreaterThan(guard);
  });

  test('unsupported is a refusal, not an empty provider catalog', () => {
    const body = browserProviderUnsupportedBody();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('UNSUPPORTED');
    expect(body).not.toHaveProperty('providers');
    expect(body).not.toHaveProperty('data');
  });
});
