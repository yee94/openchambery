import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, test, vi } from 'vitest';
import {
  __clearHostSseEmittersForTests,
  injectHostSseEvent,
  registerHostSseEmitter,
} from './host-sse-fanout';
import {
  __clearReadinessRetryForTests,
  __getSessionMetadataBoundScopeForTests,
  __getSessionMetadataRuntimeGenerationForTests,
  __getSessionMetadataStoreForTests,
  __resetSessionMetadataRuntimeForTests,
  __setSessionMetadataDataRootForTests,
  addSessionMetadataEventSink,
  buildUpstreamSessionGetUrl,
  forgetSessionMetadata,
  isHostSessionMetadataReady,
  isSessionDeletePath,
  isSessionMetadataStoreConfigured,
  METADATA_UNAVAILABLE_CODE,
  normalizeSessionEventType,
  normalizeSessionMetadataRuntimeScope,
  overlaySessionProxyBodyText,
  projectOutboundSessionLifecycleEvent,
  readSessionIdFromSessionPath,
  resolveDeletedSessionId,
  resolveSessionMetadataDataDirForScope,
  resolveSessionProxyOverlay,
  startSessionMetadataRuntime,
  stopSessionMetadataRuntime,
  tryHandleSessionMetadataProxy,
  waitForSessionMetadataReady,
} from './session-metadata-runtime';
import type { OpenCodeManager } from './opencode';

const tempRoots: string[] = [];

const makeDataRoot = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-session-meta-'));
  tempRoots.push(dir);
  return dir;
};

const makeManager = (
  apiUrl: string | null,
  authHeaders: Record<string, string> = {},
): OpenCodeManager =>
  ({
    getApiUrl: () => apiUrl,
    getOpenCodeAuthHeaders: () => authHeaders,
    getWorkingDirectory: () => '/workspace',
  }) as unknown as OpenCodeManager;

const encodeBody = (body: unknown): string =>
  Buffer.from(JSON.stringify(body), 'utf8').toString('base64');

const parseBody = (response: { bodyText?: string } | null): unknown => {
  if (!response?.bodyText) return null;
  return JSON.parse(response.bodyText) as unknown;
};

const awaitStoreReady = async () => {
  const store = __getSessionMetadataStoreForTests();
  assert.ok(store);
  await store!.load();
  assert.equal(isHostSessionMetadataReady(), true);
};

afterEach(() => {
  stopSessionMetadataRuntime();
  __clearReadinessRetryForTests();
  __resetSessionMetadataRuntimeForTests();
  __clearHostSseEmittersForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('normalizeSessionMetadataRuntimeScope', () => {
  test('collapses managed loopback ports; keeps external host identity', () => {
    assert.equal(
      normalizeSessionMetadataRuntimeScope('http://127.0.0.1:4096'),
      'loopback:http:',
    );
    assert.equal(
      normalizeSessionMetadataRuntimeScope('http://127.0.0.1:5099'),
      'loopback:http:',
    );
    assert.equal(
      normalizeSessionMetadataRuntimeScope('https://opencode.example:8443/api'),
      'https://opencode.example:8443',
    );
    assert.equal(normalizeSessionMetadataRuntimeScope(null), null);
  });
});

describe('buildUpstreamSessionGetUrl (v2 /api path)', () => {
  test('origin-only getApiUrl hits /api/session/:id with directory query', () => {
    const url = new URL(buildUpstreamSessionGetUrl('http://127.0.0.1:4096', 'ses_1', '/repo'));
    assert.equal(url.origin, 'http://127.0.0.1:4096');
    assert.equal(url.pathname, '/api/session/ses_1');
    assert.equal(url.searchParams.get('directory'), '/repo');
  });

  test('base already ending with /api does not double-prefix', () => {
    const url = new URL(buildUpstreamSessionGetUrl('http://127.0.0.1:4096/api/', 'ses/a'));
    assert.equal(url.pathname, '/api/session/ses%2Fa');
  });

  test('legacy bare /session join (without helper) is the wrong path', () => {
    // Document the production bug we fixed: origin + 'session/id' loses /api.
    const wrong = new URL('session/ses_1', 'http://127.0.0.1:4096/');
    assert.equal(wrong.pathname, '/session/ses_1');
    const correct = new URL(buildUpstreamSessionGetUrl('http://127.0.0.1:4096', 'ses_1'));
    assert.equal(correct.pathname, '/api/session/ses_1');
    assert.notEqual(wrong.pathname, correct.pathname);
  });
});

describe('session metadata Host archive runtime', () => {
  test('archives, overlays list/get, survives restart, then unarchives', async () => {
    const dataRoot = makeDataRoot();
    __setSessionMetadataDataRootForTests(dataRoot);

    const upstream = {
      id: 'ses_1',
      title: 'Alpha',
      directory: '/repo',
      time: { created: 100, updated: 200, archived: 50 },
    };

    const fetchMock = vi.fn(async (input: string | URL | { url: string }, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(raw);
      // Wrong path (missing /api) must not succeed — archive requires real v2 URL.
      if (parsed.pathname === '/session/ses_1' || !parsed.pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }
      assert.equal(parsed.pathname, '/api/session/ses_1');
      // directory is optional on unarchive; when present must match.
      const dir = parsed.searchParams.get('directory');
      if (dir !== null) assert.equal(dir, '/repo');
      const headers = new Headers(init?.headers);
      // First archive call carries Basic auth; later unarchive may omit if manager rebound.
      if (headers.has('authorization')) {
        assert.equal(headers.get('authorization'), 'Basic dGVzdA==');
      }
      assert.equal(headers.get('accept'), 'application/json');
      return new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const broadcasts: unknown[] = [];
    addSessionMetadataEventSink({
      postMessage: (message) => {
        broadcasts.push(message);
      },
    });
    const sseChunks: string[] = [];
    registerHostSseEmitter((chunk) => {
      sseChunks.push(chunk);
    });

    const auth = { Authorization: 'Basic dGVzdA==' };
    startSessionMetadataRuntime(makeManager('http://127.0.0.1:4096', auth));
    await awaitStoreReady();
    assert.equal(isSessionMetadataStoreConfigured(), true);

    const archived = await tryHandleSessionMetadataProxy(
      'PUT',
      '/openchamber/sessions/ses_1/archive',
      undefined,
      encodeBody({ archivedAt: 1_700_000_000_123, directory: '/repo' }),
    );
    assert.equal(fetchMock.mock.calls.length, 1);
    // First call must have used the real v2 URL + auth.
    {
      const firstUrl = String(fetchMock.mock.calls[0]![0]);
      assert.equal(new URL(firstUrl).pathname, '/api/session/ses_1');
      const firstInit = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
      assert.equal(new Headers(firstInit?.headers).get('authorization'), 'Basic dGVzdA==');
    }
    assert.equal(archived?.status, 200);
    const archivedBody = parseBody(archived) as {
      session: { time: { archived?: number; created: number; updated: number }; metadata: unknown };
      index?: { ok: boolean };
    };
    assert.equal(archivedBody.session.time.archived, 1_700_000_000_123);
    assert.equal(archivedBody.session.time.created, 100);
    assert.equal(archivedBody.session.time.updated, 200);
    assert.deepEqual(
      (archivedBody.session.metadata as { openchamber: { archive: { archivedAt: number } } })
        .openchamber.archive,
      { archivedAt: 1_700_000_000_123 },
    );
    assert.ok(archivedBody.index == null || archivedBody.index.ok === true);

    assert.equal(broadcasts.length, 1);
    assert.equal((broadcasts[0] as { type: string }).type, 'session.updated');
    assert.equal(sseChunks.length, 1);
    assert.ok(sseChunks[0].includes('"session.updated"'));

    const listOverlay = await resolveSessionProxyOverlay(
      'GET',
      '/session',
      200,
      JSON.stringify([upstream]),
    );
    assert.equal(listOverlay.kind, 'overlay');
    if (listOverlay.kind === 'overlay') {
      const listParsed = JSON.parse(listOverlay.bodyText) as Array<{ time: { archived?: number } }>;
      assert.equal(listParsed[0].time.archived, 1_700_000_000_123);
    }

    const getOverlay = await resolveSessionProxyOverlay(
      'GET',
      '/session/ses_1',
      200,
      JSON.stringify(upstream),
    );
    assert.equal(getOverlay.kind, 'overlay');
    if (getOverlay.kind === 'overlay') {
      assert.equal(
        (JSON.parse(getOverlay.bodyText) as { time: { archived?: number } }).time.archived,
        1_700_000_000_123,
      );
    }

    // Restart: new process-like store load from the same data root + scope.
    stopSessionMetadataRuntime();
    startSessionMetadataRuntime(makeManager('http://127.0.0.1:5099', auth)); // same loopback scope
    await awaitStoreReady();
    assert.equal(__getSessionMetadataBoundScopeForTests(), 'loopback:http:');

    const afterRestart = overlaySessionProxyBodyText(
      'GET',
      '/session/ses_1',
      200,
      JSON.stringify(upstream),
    );
    assert.equal(
      (JSON.parse(afterRestart!) as { time: { archived?: number } }).time.archived,
      1_700_000_000_123,
    );

    const unarchived = await tryHandleSessionMetadataProxy(
      'PUT',
      '/api/openchamber/sessions/ses_1/archive',
      undefined,
      encodeBody({ archivedAt: 0 }),
    );
    assert.equal(unarchived?.status, 200);
    const unBody = parseBody(unarchived) as { session: { time: { archived?: number } } };
    assert.equal(unBody.session.time.archived, undefined);

    const afterCancel = await resolveSessionProxyOverlay(
      'GET',
      '/session/ses_1',
      200,
      JSON.stringify(upstream),
    );
    assert.equal(afterCancel.kind, 'overlay');
    if (afterCancel.kind === 'overlay') {
      assert.equal(
        (JSON.parse(afterCancel.bodyText) as { time: { archived?: number } }).time.archived,
        undefined,
      );
    }
  });

  test('SSE lifecycle overlay keeps Host archive against upstream wipe (v2 shapes)', async () => {
    const dataRoot = makeDataRoot();
    __setSessionMetadataDataRootForTests(dataRoot);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({
          id: 'ses_2',
          title: 'Beta',
          directory: '/repo',
          time: { created: 1, updated: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    startSessionMetadataRuntime(makeManager('http://127.0.0.1:1'));
    await awaitStoreReady();
    await tryHandleSessionMetadataProxy(
      'PUT',
      '/openchamber/sessions/ses_2/archive',
      undefined,
      encodeBody({ archivedAt: 99 }),
    );

    const upstreamEvent = {
      type: 'session.updated',
      properties: {
        info: {
          id: 'ses_2',
          title: 'Beta renamed',
          directory: '/repo',
          time: { created: 1, updated: 3 },
        },
      },
    };
    const projected = projectOutboundSessionLifecycleEvent(upstreamEvent) as {
      properties: { info: { title: string; time: { archived?: number } } };
    };
    assert.equal(projected.properties.info.title, 'Beta renamed');
    assert.equal(projected.properties.info.time.archived, 99);

    const projectedV2 = projectOutboundSessionLifecycleEvent({
      directory: '/repo',
      payload: {
        type: 'session.updated.v2',
        data: {
          info: {
            id: 'ses_2',
            title: 'V2',
            time: { created: 1, updated: 4, archived: 50 },
          },
        },
      },
    }) as {
      directory: string;
      payload: { type: string; data: { info: { time: { archived?: number } } } };
    };
    assert.equal(projectedV2.directory, '/repo');
    assert.equal(projectedV2.payload.type, 'session.updated.v2');
    assert.equal(projectedV2.payload.data.info.time.archived, 99);
  });

  test('suppresses lifecycle SSE until Host store is ready (real corrupt inject)', async () => {
    // Not started → unconfigured → pass through
    const bare = { type: 'session.updated', properties: { info: { id: 'ses_x', time: {} } } };
    assert.equal(projectOutboundSessionLifecycleEvent(bare), bare);

    // Real corrupt inject at the exact on-disk path the runtime will open.
    // Using resolveSessionMetadataDataDirForScope avoids path-sanitization drift
    // that would turn corrupt into ENOENT empty-success (oracle false positive).
    const root = makeDataRoot();
    __setSessionMetadataDataRootForTests(root);
    const scope = normalizeSessionMetadataRuntimeScope('http://127.0.0.1:9');
    assert.ok(scope);
    const corruptDir = resolveSessionMetadataDataDirForScope(scope!);
    fs.mkdirSync(corruptDir, { recursive: true });
    const corruptFile = path.join(corruptDir, 'sessions-metadata.json');
    fs.writeFileSync(corruptFile, '{not-json', 'utf8');
    assert.equal(fs.readFileSync(corruptFile, 'utf8'), '{not-json');

    startSessionMetadataRuntime(makeManager('http://127.0.0.1:9'));
    const store = __getSessionMetadataStoreForTests();
    assert.ok(store);
    assert.equal(store!.filePath, corruptFile);

    const loadResult = await store!.load();
    // Must be a real failure — not empty-success from a missed path.
    assert.equal(loadResult.ok, false, `expected corrupt load failure, got ${JSON.stringify(loadResult)}`);
    assert.ok(loadResult.reason, 'corrupt load must surface a reason');
    // Node JSON.parse message varies; store reason is the parse error string.
    assert.match(String(loadResult.reason), /JSON|property|corrupt|parse|metadata|position/i);
    assert.equal(isHostSessionMetadataReady(), false);
    assert.equal(isSessionMetadataStoreConfigured(), true);
    assert.equal(store!.isLoaded(), false);
    assert.equal(store!.getSnapshotSync(), null);

    const suppressed = projectOutboundSessionLifecycleEvent({
      type: 'session.updated',
      properties: { info: { id: 'ses_x', time: { archived: 1 } } },
    });
    assert.equal(suppressed, null);

    const msgKept = projectOutboundSessionLifecycleEvent({
      type: 'message.updated',
      properties: { info: { role: 'user' } },
    });
    assert.equal((msgKept as { type: string }).type, 'message.updated');

    const listUnavailable = await resolveSessionProxyOverlay(
      'GET',
      '/session',
      200,
      JSON.stringify([{ id: 'ses_x', time: {} }]),
    );
    assert.equal(listUnavailable.kind, 'unavailable');
    if (listUnavailable.kind === 'unavailable') {
      assert.match(listUnavailable.error, /unavailable|corrupt/i);
    }

    // waitForSessionMetadataReady must observe load { ok: false }, not hang forever.
    const waited = await waitForSessionMetadataReady({ timeoutMs: 400 });
    assert.equal(waited.ok, false);
    if (!waited.ok) {
      assert.equal(waited.retryable, true);
      // Reason may be the raw parse error or the unavailable wrapper.
      assert.match(waited.error, /unavailable|corrupt|JSON|property|parse|position/i);
    }
  });

  test('waitForSessionMetadataReady succeeds after healthy load and gates lifecycle', async () => {
    __setSessionMetadataDataRootForTests(makeDataRoot());
    startSessionMetadataRuntime(makeManager('http://127.0.0.1:1'));
    // Before load settles, lifecycle may still be suppressed.
    const waited = await waitForSessionMetadataReady({ timeoutMs: 5_000 });
    assert.equal(waited.ok, true);
    assert.equal(isHostSessionMetadataReady(), true);

    // Ready: lifecycle projects (no host entry → identity-preserving pass).
    const event = {
      type: 'session.updated',
      properties: { info: { id: 'ses_ready', time: { created: 1, updated: 2 } } },
    };
    const projected = projectOutboundSessionLifecycleEvent(event);
    assert.ok(projected);
    assert.notEqual(projected, null);
  });

  test('refuses missing upstream, directory mismatch, id mismatch, and invalid body', async () => {
    __setSessionMetadataDataRootForTests(makeDataRoot());
    startSessionMetadataRuntime(makeManager('http://127.0.0.1:1'));
    await awaitStoreReady();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    const missing = await tryHandleSessionMetadataProxy(
      'PUT',
      '/openchamber/sessions/ses_missing/archive',
      undefined,
      encodeBody({ archivedAt: 1 }),
    );
    assert.equal(missing?.status, 404);
    assert.equal((parseBody(missing) as { code: string }).code, 'not_found');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({
          id: 'ses_1',
          location: { directory: '/repo-a' },
          time: { created: 1, updated: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const mismatch = await tryHandleSessionMetadataProxy(
      'PUT',
      '/openchamber/sessions/ses_1/archive',
      undefined,
      encodeBody({ archivedAt: 1, directory: '/repo-b' }),
    );
    assert.equal(mismatch?.status, 403);
    assert.equal((parseBody(mismatch) as { code: string }).code, 'directory_mismatch');
    const store = __getSessionMetadataStoreForTests();
    assert.ok(store);
    await assert.deepEqual(await store!.get('ses_1'), {});

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({
          id: 'ses_OTHER',
          directory: '/repo',
          time: { created: 1, updated: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const idMismatch = await tryHandleSessionMetadataProxy(
      'PUT',
      '/openchamber/sessions/ses_1/archive',
      undefined,
      encodeBody({ archivedAt: 1 }),
    );
    assert.equal(idMismatch?.status, 502);
    assert.equal((parseBody(idMismatch) as { code: string }).code, 'id_mismatch');

    const badBody = await tryHandleSessionMetadataProxy(
      'PUT',
      '/openchamber/sessions/ses_1/archive',
      undefined,
      encodeBody({}),
    );
    assert.equal(badBody?.status, 400);
  });

  test('runtime scopes isolate durable stores and bump generation', async () => {
    const dataRoot = makeDataRoot();
    __setSessionMetadataDataRootForTests(dataRoot);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({
          id: 'ses_shared',
          directory: '/repo',
          time: { created: 1, updated: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );

    startSessionMetadataRuntime(makeManager('https://host-a.example:8443'));
    await awaitStoreReady();
    const genA = __getSessionMetadataRuntimeGenerationForTests();
    await tryHandleSessionMetadataProxy(
      'PUT',
      '/openchamber/sessions/ses_shared/archive',
      undefined,
      encodeBody({ archivedAt: 111 }),
    );
    assert.equal(__getSessionMetadataBoundScopeForTests(), 'https://host-a.example:8443');

    // Switch to a different external runtime — archive must not leak.
    startSessionMetadataRuntime(makeManager('https://host-b.example:8443'));
    await awaitStoreReady();
    const genB = __getSessionMetadataRuntimeGenerationForTests();
    assert.ok(genB > genA);
    assert.equal(__getSessionMetadataBoundScopeForTests(), 'https://host-b.example:8443');
    const leaked = await resolveSessionProxyOverlay(
      'GET',
      '/session/ses_shared',
      200,
      JSON.stringify({
        id: 'ses_shared',
        directory: '/repo',
        time: { created: 1, updated: 2 },
      }),
    );
    assert.equal(leaked.kind, 'overlay');
    if (leaked.kind === 'overlay') {
      assert.equal(
        (JSON.parse(leaked.bodyText) as { time: { archived?: number } }).time.archived,
        undefined,
      );
    }

    // Back to scope A — archive still present on disk.
    startSessionMetadataRuntime(makeManager('https://host-a.example:8443'));
    await awaitStoreReady();
    const restored = await resolveSessionProxyOverlay(
      'GET',
      '/session/ses_shared',
      200,
      JSON.stringify({
        id: 'ses_shared',
        directory: '/repo',
        time: { created: 1, updated: 2 },
      }),
    );
    assert.equal(restored.kind, 'overlay');
    if (restored.kind === 'overlay') {
      assert.equal(
        (JSON.parse(restored.bodyText) as { time: { archived?: number } }).time.archived,
        111,
      );
    }
  });

  test('session.deleted and session.deleted.v2 cleanup; forget is idempotent', async () => {
    __setSessionMetadataDataRootForTests(makeDataRoot());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({
          id: 'ses_del',
          directory: '/repo',
          time: { created: 1, updated: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    startSessionMetadataRuntime(makeManager('http://127.0.0.1:1'));
    await awaitStoreReady();
    await tryHandleSessionMetadataProxy(
      'PUT',
      '/openchamber/sessions/ses_del/archive',
      undefined,
      encodeBody({ archivedAt: 42 }),
    );
    const store = __getSessionMetadataStoreForTests();
    assert.ok(store);
    await assert.deepEqual(await store!.get('ses_del'), {
      openchamber: { archive: { archivedAt: 42 } },
    });

    assert.equal(resolveDeletedSessionId({
      type: 'session.deleted.v2',
      data: { info: { id: 'ses_del' } },
    }), 'ses_del');
    assert.equal(normalizeSessionEventType('session.deleted.v2'), 'session.deleted');

    await forgetSessionMetadata('ses_del');
    await assert.deepEqual(await store!.get('ses_del'), {});
    // Idempotent second forget
    assert.equal(await forgetSessionMetadata('ses_del'), false);
  });

  test('DELETE path helpers and bridge cleanup contract', () => {
    assert.equal(isSessionDeletePath('/api/session/ses_1'), true);
    assert.equal(isSessionDeletePath('/session/ses_1?directory=/r'), true);
    assert.equal(isSessionDeletePath('/session/ses_1/message'), false);
    assert.equal(readSessionIdFromSessionPath('/api/session/ses%2Fa'), 'ses/a');
  });

  test('metadata PUT merge-patches and strips archive without allow flag', async () => {
    __setSessionMetadataDataRootForTests(makeDataRoot());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({
          id: 'ses_m',
          directory: '/repo',
          time: { created: 1, updated: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    startSessionMetadataRuntime(makeManager('http://127.0.0.1:1'));
    await awaitStoreReady();
    await tryHandleSessionMetadataProxy(
      'PUT',
      '/openchamber/sessions/ses_m/archive',
      undefined,
      encodeBody({ archivedAt: 77 }),
    );

    const meta = await tryHandleSessionMetadataProxy(
      'PUT',
      '/openchamber/sessions/ses_m/metadata',
      undefined,
      encodeBody({
        patch: {
          openchamber: {
            goal: { status: 'active' },
            archive: { archivedAt: 1 },
          },
        },
      }),
    );
    assert.equal(meta?.status, 200);
    const body = parseBody(meta) as {
      metadata: { openchamber: { goal: unknown; archive: { archivedAt: number } } };
    };
    assert.deepEqual(body.metadata.openchamber.goal, { status: 'active' });
    assert.equal(body.metadata.openchamber.archive.archivedAt, 77);
  });

  test('injectHostSseEvent fans out to registered emitters', () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = registerHostSseEmitter((c) => a.push(c));
    registerHostSseEmitter((c) => b.push(c));
    injectHostSseEvent({ type: 'session.updated', properties: { sessionID: 'x' } });
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    offA();
    injectHostSseEvent({ type: 'session.updated', properties: { sessionID: 'y' } });
    assert.equal(a.length, 1);
    assert.equal(b.length, 2);
  });

  test('METADATA_UNAVAILABLE_CODE is stable for clients', () => {
    assert.equal(METADATA_UNAVAILABLE_CODE, 'session_metadata_unavailable');
  });
});
