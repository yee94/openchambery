import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ConfigResponse = { data: Record<string, unknown> };

(mock as unknown as { restore?: () => void }).restore?.();

const configResolvers: Array<(response: ConfigResponse) => void> = [];
let configCalls = 0;
const promptAsyncCalls: unknown[][] = [];
const promptAsyncResults: Array<unknown> = [];
let runtimeKey = 'test-runtime';
let runtimeBase = '/api';
const healthFetchCalls: unknown[][] = [];
const healthFetchResults: Array<Response | Error | Promise<Response>> = [];
const agentSdkCalls: unknown[][] = [];

const promptAsyncMock = mock(async (...args: unknown[]) => {
  promptAsyncCalls.push(args);
  const next = promptAsyncResults.shift();
  if (next instanceof Error) throw next;
  return next ?? { response: new Response(null, { status: 200 }) };
});

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: mock(() => ({
    config: {
      get: mock(() => {
        configCalls += 1;
        return new Promise<ConfigResponse>((resolve) => {
          configResolvers.push(resolve);
        });
      }),
    },
    app: {
      agents: mock((...args: unknown[]) => {
        agentSdkCalls.push(args);
        return Promise.resolve({ data: [{ name: 'build' }] });
      }),
    },
    session: {
      promptAsync: promptAsyncMock,
    },
  })),
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: () => runtimeBase,
  })),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: mock(() => ''),
  getRuntimeKey: mock(() => runtimeKey),
}));

const runtimeFetchMock = mock((...args: unknown[]) => {
  healthFetchCalls.push(args);
  const next = healthFetchResults.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? new Response(JSON.stringify({ healthy: true }), {
    headers: { 'Content-Type': 'application/json' },
  }));
});

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { opencodeClient } = await import(`./client?cache-test=${Date.now()}`);

beforeEach(() => {
  promptAsyncCalls.length = 0;
  promptAsyncResults.length = 0;
  healthFetchCalls.length = 0;
  healthFetchResults.length = 0;
  agentSdkCalls.length = 0;
  runtimeKey = 'test-runtime';
  runtimeBase = '/api';
});

describe('opencodeClient catalog abort signals', () => {
  test('passes signals to scoped SDK catalog requests', async () => {
    const agentSignal = new AbortController().signal;

    await opencodeClient.listAgents('/workspace/project', agentSignal);

    expect(agentSdkCalls[0]?.[1]).toEqual({ signal: agentSignal });
  });
});

describe('opencodeClient getConfig cache', () => {
  test('cleared stale in-flight requests do not repopulate cache or delete newer in-flight requests', async () => {
    const first = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(1);

    opencodeClient.clearConfigCache();

    const second = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[0]?.({ data: { model: 'old/model' } });
    expect(await first).toEqual({ model: 'old/model' });

    const third = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[1]?.({ data: { model: 'new/model' } });
    expect(await second).toEqual({ model: 'new/model' });
    expect(await third).toEqual({ model: 'new/model' });

    const cached = await opencodeClient.getConfig('/workspace/project');
    expect(cached).toEqual({ model: 'new/model' });
    expect(configCalls).toBe(2);
  });
});

describe('opencodeClient prompt retry behavior', () => {
  const sendPrompt = (providerID = 'anthropic') => opencodeClient.sendMessage({
    id: 'ses_1',
    providerID,
    modelID: 'claude-sonnet',
    text: 'hello',
  });

  test('does not retry 504 prompt responses because the POST may already be accepted', async () => {
    promptAsyncResults.push({ response: new Response('gateway timeout', { status: 504 }) });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-504');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (504)');
  });

  test('does not retry transport failures because the tunnel may have lost only the response', async () => {
    promptAsyncResults.push(new TypeError('Failed to fetch'));

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-network');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to fetch');
  });

  test('does not fabricate an HTTP 500 when the SDK swallows a transport failure into result.error', async () => {
    // The SDK catches thrown fetch errors and returns { error, response: undefined }.
    // That is a transport failure, not a server 500 — it must surface as a
    // descriptive transport error, never as "Failed to send message (500): {}".
    promptAsyncResults.push({ error: new TypeError('relay tunnel reset: plaintext frame on established channel'), response: undefined });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-transport');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('Failed to send message (500)');
    expect(message).toContain('transport failure');
    expect(message).toContain('relay tunnel reset');
    expect((error as Error & { status?: number }).status).toBe(undefined);
  });

  test('does not retry 503 prompt responses because proxy errors can be ambiguous too', async () => {
    promptAsyncResults.push({ response: new Response('starting', { status: 503 }) });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-503');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (503)');
  });
});

describe('opencodeClient checkHealth cache', () => {
  test('merges concurrent probes for the same runtime', async () => {
    let resolveHealth: (response: Response) => void = () => undefined;
    healthFetchResults.push(new Promise((resolve) => {
      resolveHealth = resolve;
    }));

    const first = opencodeClient.checkHealth();
    const second = opencodeClient.checkHealth();
    expect(healthFetchCalls.length).toBe(1);

    resolveHealth(new Response(JSON.stringify({ healthy: true }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });

  test('uses successful health results within the runtime TTL', async () => {
    runtimeKey = 'health-ttl-runtime';
    expect(await opencodeClient.checkHealth()).toBe(true);
    expect(await opencodeClient.checkHealth()).toBe(true);
    expect(healthFetchCalls.length).toBe(1);
  });

  test('isolates health probes by runtime key', async () => {
    runtimeKey = 'health-runtime-a';
    expect(await opencodeClient.checkHealth()).toBe(true);

    runtimeKey = 'health-runtime-b';
    expect(await opencodeClient.checkHealth()).toBe(true);
    expect(healthFetchCalls.length).toBe(2);
  });

  test('merges failed probes and shares the failure TTL', async () => {
    runtimeKey = 'health-failure-ttl-runtime';
    let resolveHealth: (response: Response) => void = () => undefined;
    healthFetchResults.push(new Promise((resolve) => {
      resolveHealth = resolve;
    }));

    const first = opencodeClient.checkHealth();
    const second = opencodeClient.checkHealth();
    expect(healthFetchCalls.length).toBe(1);

    resolveHealth(new Response('starting', { status: 503 }));
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(await opencodeClient.checkHealth()).toBe(false);
    expect(healthFetchCalls.length).toBe(1);
  });

  test('reprobes after the failure TTL expires', async () => {
    const originalDateNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      runtimeKey = 'health-failure-expiry-runtime';
      healthFetchResults.push(new TypeError('network unavailable'));
      expect(await opencodeClient.checkHealth()).toBe(false);
      expect(await opencodeClient.checkHealth()).toBe(false);
      expect(healthFetchCalls.length).toBe(1);

      now += 1_001;
      expect(await opencodeClient.checkHealth()).toBe(true);
      expect(healthFetchCalls.length).toBe(2);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test('caches false for unhealthy and malformed health responses', async () => {
    for (const [key, response] of [
      ['health-unhealthy-runtime', new Response(JSON.stringify({ healthy: false }), { headers: { 'Content-Type': 'application/json' } })],
      ['health-malformed-runtime', new Response('invalid json', { headers: { 'Content-Type': 'application/json' } })],
    ] as const) {
      runtimeKey = key;
      healthFetchResults.push(response);
      expect(await opencodeClient.checkHealth()).toBe(false);
      expect(await opencodeClient.checkHealth()).toBe(false);
    }
    expect(healthFetchCalls.length).toBe(2);
  });

  test('clears health state on runtime base changes without caching stale responses', async () => {
    runtimeKey = 'health-old-runtime';
    let resolveHealth: (response: Response) => void = () => undefined;
    healthFetchResults.push(new Promise((resolve) => {
      resolveHealth = resolve;
    }));
    const oldRequest = opencodeClient.checkHealth();

    runtimeBase = '/next/api';
    opencodeClient.reconnectToRuntimeBaseUrl();
    resolveHealth(new Response(JSON.stringify({ healthy: true }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(await oldRequest).toBe(false);

    expect(await opencodeClient.checkHealth()).toBe(true);
    expect(healthFetchCalls.length).toBe(2);
  });
});
