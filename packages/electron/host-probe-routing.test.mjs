import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { probeHostAuthentication } from './host-auth-probe.mjs';

const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const probeSource = main.slice(main.indexOf('const buildHealthUrl ='), main.indexOf('const resolveStoredClientTokenForUrl ='));
const context = vm.createContext({
  URL, AbortSignal, fetch, setTimeout,
  electronNet: { fetch },
  sanitizeRuntimeRequestHeaders: (headers) => headers,
  probeHostAuthentication,
});
vm.runInContext(`${probeSource}\nglobalThis.probe = probeHostWithTimeout;`, context);

let server;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  server = undefined;
});

const startCandidate = async (health) => {
  const requests = [];
  server = http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.statusCode = health.status ?? 200;
      if (health.redirect) res.setHeader('location', '/api/version');
      if (health.hang) return;
      res.end(typeof health.body === 'string' ? health.body : JSON.stringify(health.body));
      return;
    }
    res.end(JSON.stringify(req.url === '/auth/session'
      ? { authenticated: true }
      : { status: 'ok', compatibility: { apiVersion: 1, minClientApiVersion: 1, capabilities: ['api.runtime-url.v1'] } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
};

describe('Relay direct-candidate identity gate', () => {
  it.each([
    ['missing identity', { body: { status: 'ok' } }, 'wrong-service'],
    ['different computer', { body: { serverId: 'local-computer' } }, 'wrong-service'],
    ['invalid JSON', { body: 'not-json' }, 'wrong-service'],
    ['health failure', { status: 503, body: {} }, 'unreachable'],
    ['redirect', { status: 302, body: {}, redirect: true }, 'unreachable'],
  ])('does not adopt a locally reachable candidate with %s', async (_label, health, status) => {
    const candidate = await startCandidate(health);
    const result = await context.probe(candidate.url, 1000, 'test-remote-credential', {}, 'remote-computer');
    expect(result.status).toBe(status);
    expect(candidate.requests).toEqual([{ path: '/health', authorization: undefined }]);
  });

  it('does not fall through to direct authentication when identity lookup times out', async () => {
    const candidate = await startCandidate({ hang: true });
    expect((await context.probe(candidate.url, 50, 'test-remote-credential', {}, 'remote-computer')).status).toBe('unreachable');
    expect(candidate.requests).toEqual([{ path: '/health', authorization: undefined }]);
  });

  it('accepts direct only after matching the paired computer and authenticating', async () => {
    const candidate = await startCandidate({ body: { serverId: 'remote-computer' } });
    expect((await context.probe(candidate.url, 1000, 'test-remote-credential', {}, 'remote-computer')).status).toBe('ok');
    expect(candidate.requests).toEqual([
      { path: '/health', authorization: undefined },
      { path: '/api/version', authorization: 'Bearer test-remote-credential' },
      { path: '/auth/session', authorization: 'Bearer test-remote-credential' },
    ]);
  });

  it('preserves explicit direct-only hosts without a pinned Relay identity', async () => {
    const candidate = await startCandidate({ body: {} });
    expect((await context.probe(candidate.url, 1000, 'test-direct-credential')).status).toBe('ok');
    expect(candidate.requests.map((request) => request.path)).toEqual(['/api/version', '/auth/session']);
  });
});
