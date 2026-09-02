import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import { handleOtaProxyRequest } from '../lib/ota-proxy.js';

const ORIGIN = 'https://upstream.example.com';

let restoreFetch = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

function stubUpstream(handler) {
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (input, init) => {
    fetched.push({ url: String(input), init });
    return handler(String(input), init);
  };
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };
  return fetched;
}

function otaRequest(path, method = 'GET') {
  return new Request(`https://proxy.example.com${path}`, { method });
}

test('proxies channel manifests upstream with short edge cache', async () => {
  stubUpstream(() => new Response('{"generation":2}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  const response = await handleOtaProxyRequest(
    otaRequest('/ota/channels/beta.json'),
    { upstreamOrigin: ORIGIN },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"generation":2}');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  assert.equal(response.headers.get('x-ota-proxy'), 'edgeone');
});

test('proxies content-addressed bundles with immutable cache', async () => {
  const fetched = stubUpstream(() => new Response('zip-bytes', {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-length': '9' },
  }));
  const response = await handleOtaProxyRequest(
    otaRequest('/ota/bundles/34ab092a8e7f6d21.zip'),
    { upstreamOrigin: ORIGIN },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('content-length'), '9');
  assert.equal(fetched[0].url, `${ORIGIN}/ota/bundles/34ab092a8e7f6d21.zip`);
});

test('rejects non-allowlisted paths and methods without upstream fetch', async () => {
  const fetched = stubUpstream(() => new Response('should not be reached'));
  for (const path of [
    '/ota/channels/../../secret',
    '/ota/channels/evil.js',
    '/ota/bundles/nothex.zip',
    '/v1/ota/check',
    '/secrets.md',
    '/CHANGELOG.md.bak',
    '/sub/CHANGELOG.md',
  ]) {
    const response = await handleOtaProxyRequest(otaRequest(path), { upstreamOrigin: ORIGIN });
    assert.equal(response.status, 404, path);
  }
  const post = await handleOtaProxyRequest(
    new Request('https://proxy.example.com/ota/channels/beta.json', { method: 'POST' }),
    { upstreamOrigin: ORIGIN },
  );
  assert.equal(post.status, 404);
  assert.equal(fetched.length, 0);
});

test('proxies /CHANGELOG.md with short edge cache and preserves content-type', async () => {
  const markdown = '## [1.19.0-beta.8]\n\n- notes';
  const fetched = stubUpstream(() => new Response(markdown, {
    status: 200,
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-length': String(markdown.length) },
  }));
  const response = await handleOtaProxyRequest(
    otaRequest('/CHANGELOG.md'),
    { upstreamOrigin: ORIGIN },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), markdown);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(response.headers.get('x-ota-proxy'), 'edgeone');
  assert.equal(fetched[0].url, `${ORIGIN}/CHANGELOG.md`);
});

test('CHANGELOG upstream failure surfaces as 502, never as empty 200', async () => {
  stubUpstream(() => Promise.reject(new Error('changelog origin down')));
  const response = await handleOtaProxyRequest(
    otaRequest('/CHANGELOG.md'),
    { upstreamOrigin: ORIGIN },
  );
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.error, 'ota_upstream_unavailable');
  assert.match(body.detail, /changelog origin down/);
});

test('CHANGELOG paths never forward Range even when the client sends one', async () => {
  const fetched = stubUpstream((_url, init) => {
    assert.equal(init?.headers?.Range, undefined);
    return new Response('## [1.19.0]\n', {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    });
  });
  const response = await handleOtaProxyRequest(
    new Request('https://proxy.example.com/CHANGELOG.md', {
      method: 'GET',
      headers: { Range: 'bytes=0-10' },
    }),
    { upstreamOrigin: ORIGIN },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  assert.equal(fetched[0].init.headers.Range, undefined);
});

test('upstream miss passes through 404 without caching', async () => {
  stubUpstream(() => new Response('Not found', { status: 404 }));
  const response = await handleOtaProxyRequest(
    otaRequest('/ota/channels/stable.json'),
    { upstreamOrigin: ORIGIN },
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('upstream failure surfaces as 502, never as authoritative empty success', async () => {
  stubUpstream(() => Promise.reject(new Error('network down')));
  const response = await handleOtaProxyRequest(
    otaRequest('/ota/channels/beta.json'),
    { upstreamOrigin: ORIGIN },
  );
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'ota_upstream_unavailable', detail: 'Error: network down' });
});

test('HEAD requests return empty body but keep headers', async () => {
  stubUpstream(() => new Response('zip-bytes', {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-length': '9' },
  }));
  const response = await handleOtaProxyRequest(
    otaRequest('/ota/bundles/34ab092a8e7f6d21.zip', 'HEAD'),
    { upstreamOrigin: ORIGIN },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('content-length'), '9');
});

test('forwards Range on bundle paths and returns 206 with no-store cache', async () => {
  const fetched = stubUpstream((_url, init) => {
    assert.equal(init?.headers?.Range, 'bytes=100-');
    assert.equal(init?.headers?.Accept, '*/*');
    return new Response('partial-zip', {
      status: 206,
      headers: {
        'content-type': 'application/zip',
        'content-length': '11',
        'content-range': 'bytes 100-110/999',
        'accept-ranges': 'bytes',
      },
    });
  });
  const response = await handleOtaProxyRequest(
    new Request('https://proxy.example.com/ota/bundles/34ab092a8e7f6d21.zip', {
      method: 'GET',
      headers: { Range: 'bytes=100-' },
    }),
    { upstreamOrigin: ORIGIN },
  );
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-range'), 'bytes 100-110/999');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(fetched[0].init.headers.Range, 'bytes=100-');
});

test('full bundle GET without Range keeps immutable cache and does not send Range upstream', async () => {
  const fetched = stubUpstream(() => new Response('zip-bytes', {
    status: 200,
    headers: { 'content-type': 'application/zip', 'content-length': '9' },
  }));
  const response = await handleOtaProxyRequest(
    otaRequest('/ota/bundles/34ab092a8e7f6d21.zip'),
    { upstreamOrigin: ORIGIN },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(fetched[0].init.headers.Range, undefined);
  assert.equal(fetched[0].init.headers.Accept, '*/*');
});

test('channel paths never forward Range even when the client sends one', async () => {
  const fetched = stubUpstream((_url, init) => {
    assert.equal(init?.headers?.Range, undefined);
    return new Response('{"generation":2}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const response = await handleOtaProxyRequest(
    new Request('https://proxy.example.com/ota/channels/beta.json', {
      method: 'GET',
      headers: { Range: 'bytes=0-10' },
    }),
    { upstreamOrigin: ORIGIN },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  assert.equal(fetched[0].init.headers.Range, undefined);
});
