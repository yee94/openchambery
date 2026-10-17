import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { configureOpenCodeCredentials } from '../opencode/auth.js';
import { registerQuotaRoutes } from './routes.js';

const servers = [];
async function serve(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => {
  configureOpenCodeCredentials(null);
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe('Magpie host HTTP boundary', () => {
  it('discovers a renamed authenticated gateway on a custom port with a proxy prefix and projects multiple providers', async () => {
    const paths = [];
    const gateway = express();
    gateway.use((req, res, next) => {
      expect(req.headers.authorization).toBe('Bearer test-gateway-key');
      paths.push(req.url); next();
    });
    gateway.get('/proxy/v1', (_req, res) => res.json({ name: 'magpie', apis: ['/v1/magpie/quotas'] }));
    gateway.get('/proxy/v1/magpie/quotas', (_req, res) => res.json({ object: 'list', data: ['claude', 'codex'].map((provider) => ({ provider, name: provider, kind: 'subscription', user: 'account', windows: [{ name: 'daily', used: 40, remaining: 60, resetsAt: '2026-10-19T00:00:00Z' }] })) }));
    const baseURL = `${await serve(gateway)}/proxy/v1`;
    configureOpenCodeCredentials(() => ({
      config: { get: async (input) => {
        expect(input.location.directory).toBe('/project');
        return [{ type: 'document', info: { providers: { renamed: { settings: { baseURL } } } } }];
      } },
      credential: { list: async () => [{ id: 'key', integrationID: 'renamed', active: true, value: { type: 'key', key: 'test-gateway-key' } }] },
    }));
    const app = express(); registerQuotaRoutes(app, { getQuotaProviders: async () => ({}) });
    const response = await fetch(`${await serve(app)}/api/quota/magpie?directory=%2Fproject`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.sources[0].results.map((r) => r.upstreamProviderId)).toEqual(['claude', 'codex']);
    expect(paths).toEqual(['/proxy/v1', '/proxy/v1/magpie/quotas?kept=1']);
    expect(JSON.stringify(data)).not.toContain('test-gateway-key');
    expect(Object.values(data.sources[0].results[0].usage.windows)[0].resetAt).toBe(Date.parse('2026-10-19T00:00:00Z'));
  });
});
