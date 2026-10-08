import http from 'node:http';
import { once } from 'node:events';
import request from 'supertest';
import { expect, it } from 'vitest';

it('targets the test server when IPv4 and IPv6 listeners share a port', async () => {
  const other = http.createServer((_req, res) => res.writeHead(401).end('Other server'));
  const target = http.createServer((_req, res) => res.end('Test server'));
  try {
    other.listen(0, '127.0.0.1');
    await once(other, 'listening');
    target.listen({ port: other.address().port, host: '::', ipv6Only: true });
    await once(target, 'listening');
    const response = await request(target).get('/').expect(200);
    expect(response.text).toBe('Test server');
    await request(other).get('/').expect(401, 'Other server');
  } finally {
    await Promise.all([other, target].map((server) => new Promise((resolve) => server.close(resolve))));
  }
});
