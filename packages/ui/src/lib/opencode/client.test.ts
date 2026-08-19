import { beforeEach, describe, expect, test, vi } from 'vitest';

type ConfigResponse = { data: Record<string, unknown> };

const {
  configResolvers,
  promptAsyncCalls,
  promptAsyncResults,
  healthFetchCalls,
  healthFetchResults,
  agentSdkCalls,
  sessionStatusSdkCalls,
  sessionActiveSdkCalls,
  sessionActiveResults,
  sessionDiffSdkCalls,
  sessionDiffResults,
  sdkClientConfigs,
  uploadPromptAttachmentCalls,
  getConfigCalls,
  setConfigCalls,
  getRuntimeKey,
  setRuntimeKey,
  getRuntimeBase,
  setRuntimeBase,
  promptAsyncMock,
  sessionActiveMock,
  sessionDiffMock,
  runtimeFetchMock,
  uploadPromptAttachmentBytesMock,
} = vi.hoisted(() => {
  const configResolvers: Array<(response: ConfigResponse) => void> = [];
  let configCalls = 0;
  const promptAsyncCalls: unknown[][] = [];
  const promptAsyncResults: Array<unknown> = [];
  let runtimeKey = 'test-runtime';
  let runtimeBase = '/api';
  const healthFetchCalls: unknown[][] = [];
  const healthFetchResults: Array<Response | Error | Promise<Response>> = [];
  const agentSdkCalls: unknown[][] = [];
  const sessionStatusSdkCalls: unknown[][] = [];
  const sessionActiveSdkCalls: unknown[][] = [];
  const sessionActiveResults: Array<unknown> = [];
  const sdkClientConfigs: Array<unknown> = [];
  const sessionDiffSdkCalls: unknown[][] = [];
  const sessionDiffResults: Array<unknown> = [];
  const uploadPromptAttachmentCalls: Array<{ mime: string; filename?: string }> = [];

  return {
    configResolvers,
    promptAsyncCalls,
    promptAsyncResults,
    healthFetchCalls,
    healthFetchResults,
    agentSdkCalls,
    sessionStatusSdkCalls,
    sessionActiveSdkCalls,
    sessionActiveResults,
    sessionDiffSdkCalls,
    sessionDiffResults,
    sdkClientConfigs,
    uploadPromptAttachmentCalls,
    getConfigCalls: () => configCalls,
    setConfigCalls: (value: number) => { configCalls = value; },
    getRuntimeKey: () => runtimeKey,
    setRuntimeKey: (value: string) => { runtimeKey = value; },
    getRuntimeBase: () => runtimeBase,
    setRuntimeBase: (value: string) => { runtimeBase = value; },
    promptAsyncMock: vi.fn(async (...args: unknown[]) => {
      promptAsyncCalls.push(args);
      const next = promptAsyncResults.shift();
      if (next instanceof Error) throw next;
      return next ?? { response: new Response(null, { status: 200 }) };
    }),
    sessionActiveMock: vi.fn(async (...args: unknown[]) => {
      sessionActiveSdkCalls.push(args);
      const next = sessionActiveResults.shift();
      if (next instanceof Error) throw next;
      return next ?? {
        data: { data: {} },
        error: undefined,
        response: new Response(null, { status: 200 }),
      };
    }),
    sessionDiffMock: vi.fn(async (...args: unknown[]) => {
      sessionDiffSdkCalls.push(args);
      const next = sessionDiffResults.shift();
      if (next instanceof Error) throw next;
      return next ?? {
        data: [],
        error: undefined,
        response: new Response(null, { status: 200 }),
      };
    }),
    runtimeFetchMock: vi.fn((...args: unknown[]) => {
      healthFetchCalls.push(args);
      const next = healthFetchResults.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? new Response(JSON.stringify({ healthy: true }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }),
    uploadPromptAttachmentBytesMock: vi.fn(async (input: { mime: string; filename?: string }) => {
      uploadPromptAttachmentCalls.push(input);
      return {
        path: '/data/openchamber/prompt-attachments/ab/uploaded.bin',
        url: 'file:///data/openchamber/prompt-attachments/ab/uploaded.bin',
        mime: input.mime,
        size: 4,
        sha256: 'deadbeef',
      };
    }),
  };
});

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: vi.fn((config: unknown) => {
    sdkClientConfigs.push(config);
    return {
      config: {
        get: vi.fn(() => {
          setConfigCalls(getConfigCalls() + 1);
          return new Promise<ConfigResponse>((resolve) => {
            configResolvers.push(resolve);
          });
        }),
      },
      app: {
        agents: vi.fn((...args: unknown[]) => {
          agentSdkCalls.push(args);
          return Promise.resolve({ data: [{ name: 'build' }] });
        }),
      },
      session: {
        promptAsync: promptAsyncMock,
        status: vi.fn((...args: unknown[]) => {
          sessionStatusSdkCalls.push(args);
          return Promise.resolve({ data: {} });
        }),
        diff: sessionDiffMock,
      },
      v2: {
        session: {
          active: sessionActiveMock,
        },
      },
    };
  }),
}));

vi.mock('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: vi.fn(() => null),
}));

vi.mock('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: vi.fn(() => ({
    api: (path: string) => path === '/' ? (getRuntimeBase().replace(/\/api$/, '') || '/') : getRuntimeBase(),
  })),
}));

vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: vi.fn(() => ''),
  getRuntimeKey: vi.fn(() => getRuntimeKey()),
}));

vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

vi.mock('../runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

vi.mock('@/lib/startupTrace', () => ({
  markStartupTrace: vi.fn(() => undefined),
}));

const promptAttachmentUploadMock = {
  needsPromptAttachmentUpload: (url: string) => url.startsWith('data:') || url.startsWith('blob:'),
  blobFromDataUrl: (_url: string, mime: string) => new Blob(['ok'], { type: mime || 'application/octet-stream' }),
  pathFromPromptAttachmentFileUrl: (url: string) => {
    const trimmed = url.trim();
    if (!trimmed.toLowerCase().startsWith('file://')) return trimmed;
    let rest = trimmed.slice('file://'.length);
    if (rest.toLowerCase().startsWith('localhost/')) rest = rest.slice('localhost'.length);
    return rest;
  },
  uploadPromptAttachmentBytes: uploadPromptAttachmentBytesMock,
};

vi.mock('../prompt-attachment-upload', () => promptAttachmentUploadMock);
vi.mock('@/lib/prompt-attachment-upload', () => promptAttachmentUploadMock);

const { opencodeClient } = await import('./client');

beforeEach(() => {
  promptAsyncCalls.length = 0;
  promptAsyncResults.length = 0;
  healthFetchCalls.length = 0;
  healthFetchResults.length = 0;
  agentSdkCalls.length = 0;
  sessionStatusSdkCalls.length = 0;
  sessionActiveSdkCalls.length = 0;
  sessionActiveResults.length = 0;
  sessionDiffSdkCalls.length = 0;
  sessionDiffResults.length = 0;
  sdkClientConfigs.length = 0;
  uploadPromptAttachmentCalls.length = 0;
  setRuntimeKey('test-runtime');
  setRuntimeBase('/api');
});

describe('opencodeClient abort signals', () => {
  test('passes signals to scoped SDK catalog requests', async () => {
    const controller = new AbortController();

    await opencodeClient.listAgents('/workspace/project', controller.signal);

    const passed = (agentSdkCalls[0]?.[1] as { signal?: AbortSignal } | undefined)?.signal;
    expect(passed).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(passed?.aborted).toBe(true);
  });

  test('passes signals to directory session-status requests', async () => {
    const statusSignal = new AbortController().signal;

    await opencodeClient.getSessionStatusForDirectory('/workspace/project', statusSignal);

    expect(sessionStatusSdkCalls[0]).toEqual([
      { directory: '/workspace/project' },
      { signal: statusSignal },
    ]);
  });

  test('passes signals to session.active requests', async () => {
    const activeSignal = new AbortController().signal;
    await opencodeClient.getSessionActive(activeSignal);
    expect(sessionActiveSdkCalls[0]).toEqual([{ signal: activeSignal }]);
  });
});

describe('opencodeClient V2 runtime base', () => {
  test('uses the runtime origin so V2 session.active supplies its own API prefix', async () => {
    setRuntimeBase('https://runtime.example/api');

    await opencodeClient.getSessionActive();

    expect((sdkClientConfigs.at(-1) as { baseUrl: string }).baseUrl).toBe('https://runtime.example');
  });
});

describe('opencodeClient getSessionDiff', () => {
  test('returns full SnapshotFileDiff rows on success', async () => {
    const rows = [
      { file: 'src/a.ts', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-old\n+new', status: 'modified' as const },
    ];
    sessionDiffResults.push({
      data: rows,
      error: undefined,
      response: new Response(null, { status: 200 }),
    });

    const result = await opencodeClient.getSessionDiff({
      sessionID: 'ses_1',
      directory: '/workspace/project',
      messageID: 'msg_user',
    });
    expect(result).toEqual(rows);

    expect(sessionDiffSdkCalls[0]).toEqual([{
      sessionID: 'ses_1',
      directory: '/workspace/project',
      messageID: 'msg_user',
    }]);
  });

  test('throws on SDK error and does not treat failure as empty success', async () => {
    sessionDiffResults.push({
      data: undefined,
      error: { message: 'boom' },
      response: new Response(null, { status: 500 }),
    });

    let thrown: unknown;
    try {
      await opencodeClient.getSessionDiff({ sessionID: 'ses_1' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error).toBe(true);
    expect((thrown as Error).message).toContain('session.diff failed');
  });

  test('throws on empty response body', async () => {
    sessionDiffResults.push({
      data: null,
      error: undefined,
      response: new Response(null, { status: 200 }),
    });

    let thrown: unknown;
    try {
      await opencodeClient.getSessionDiff({ sessionID: 'ses_1' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error).toBe(true);
    expect((thrown as Error).message).toContain('empty response');
  });
});

describe('opencodeClient getSessionActive', () => {
  test('returns supported membership on 200', async () => {
    sessionActiveResults.push({
      data: { data: { ses_a: { type: 'running' } } },
      error: undefined,
      response: new Response(null, { status: 200 }),
    });

    expect(await opencodeClient.getSessionActive()).toEqual({
      state: 'supported',
      membership: { ses_a: { type: 'running' } },
    });
  });

  test('returns unsupported on 404/405/501', async () => {
    for (const status of [404, 405, 501]) {
      sessionActiveResults.push({
        data: undefined,
        error: { message: 'not found' },
        response: new Response(null, { status }),
      });
      expect(await opencodeClient.getSessionActive()).toEqual({ state: 'unsupported' });
    }
  });

  test('returns unknown on 5xx, network, and malformed 200', async () => {
    sessionActiveResults.push({
      data: undefined,
      error: { message: 'boom' },
      response: new Response(null, { status: 500 }),
    });
    expect(await opencodeClient.getSessionActive()).toEqual({ state: 'unknown' });

    sessionActiveResults.push(new TypeError('Failed to fetch'));
    expect(await opencodeClient.getSessionActive()).toEqual({ state: 'unknown' });

    sessionActiveResults.push({
      data: { data: { ses_a: { type: 'not-running' } } },
      error: undefined,
      response: new Response(null, { status: 200 }),
    });
    expect(await opencodeClient.getSessionActive()).toEqual({ state: 'unknown' });
  });
});

describe('opencodeClient getConfig cache', () => {
  test('cleared stale in-flight requests do not repopulate cache or delete newer in-flight requests', async () => {
    const first = opencodeClient.getConfig('/workspace/project');
    expect(getConfigCalls()).toBe(1);

    opencodeClient.clearConfigCache();

    const second = opencodeClient.getConfig('/workspace/project');
    expect(getConfigCalls()).toBe(2);

    configResolvers[0]?.({ data: { model: 'old/model' } });
    expect(await first).toEqual({ model: 'old/model' });

    const third = opencodeClient.getConfig('/workspace/project');
    expect(getConfigCalls()).toBe(2);

    configResolvers[1]?.({ data: { model: 'new/model' } });
    expect(await second).toEqual({ model: 'new/model' });
    expect(await third).toEqual({ model: 'new/model' });

    const cached = await opencodeClient.getConfig('/workspace/project');
    expect(cached).toEqual({ model: 'new/model' });
    expect(getConfigCalls()).toBe(2);
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

  test('uploads inline data URLs before promptAsync so the JSON body stays a file:// reference', async () => {
    promptAsyncResults.push({ response: new Response(null, { status: 200 }) });

    await opencodeClient.sendMessage({
      id: 'ses_1',
      providerID: 'anthropic-upload',
      modelID: 'claude-sonnet',
      text: 'see photo',
      files: [{
        type: 'file',
        mime: 'image/png',
        filename: 'photo.png',
        url: 'data:image/png;base64,aGVsbA==',
      }],
    });

    expect(uploadPromptAttachmentCalls).toHaveLength(1);
    const parts = (promptAsyncCalls[0]?.[0] as { parts?: Array<{ type: string; url?: string; mime?: string }> })?.parts;
    expect(parts?.some((part) => part.type === 'file' && part.url === 'file:///data/openchamber/prompt-attachments/ab/uploaded.bin' && part.mime === 'image/png')).toBe(true);
    expect(parts?.some((part) => part.type === 'file' && part.url?.startsWith('data:'))).toBe(false);
  });

  test('expands image citations to the uploaded host path in authored text', async () => {
    promptAsyncResults.push({ response: new Response(null, { status: 200 }) });

    await opencodeClient.sendMessage({
      id: 'ses_1',
      providerID: 'anthropic-upload',
      modelID: 'claude-sonnet',
      text: '[photo.png] what is this',
      files: [{
        type: 'file',
        mime: 'image/png',
        filename: 'photo.png',
        url: 'data:image/png;base64,aGVsbA==',
      }],
    });

    const parts = (promptAsyncCalls[0]?.[0] as { parts?: Array<{ type: string; text?: string; url?: string }> })?.parts;
    expect(parts?.some((part) => (
      part.type === 'text'
      && part.text === '[/data/openchamber/prompt-attachments/ab/uploaded.bin] what is this'
    ))).toBe(true);
    expect(parts?.some((part) => part.type === 'file' && part.url === 'file:///data/openchamber/prompt-attachments/ab/uploaded.bin')).toBe(true);
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
    setRuntimeKey('health-ttl-runtime');
    expect(await opencodeClient.checkHealth()).toBe(true);
    expect(await opencodeClient.checkHealth()).toBe(true);
    expect(healthFetchCalls.length).toBe(1);
  });

  test('isolates health probes by runtime key', async () => {
    setRuntimeKey('health-runtime-a');
    expect(await opencodeClient.checkHealth()).toBe(true);

    setRuntimeKey('health-runtime-b');
    expect(await opencodeClient.checkHealth()).toBe(true);
    expect(healthFetchCalls.length).toBe(2);
  });

  test('merges failed probes and shares the failure TTL', async () => {
    setRuntimeKey('health-failure-ttl-runtime');
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
      setRuntimeKey('health-failure-expiry-runtime');
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
      setRuntimeKey(key);
      healthFetchResults.push(response);
      expect(await opencodeClient.checkHealth()).toBe(false);
      expect(await opencodeClient.checkHealth()).toBe(false);
    }
    expect(healthFetchCalls.length).toBe(2);
  });

  test('clears health state on runtime base changes without caching stale responses', async () => {
    setRuntimeKey('health-old-runtime');
    let resolveHealth: (response: Response) => void = () => undefined;
    healthFetchResults.push(new Promise((resolve) => {
      resolveHealth = resolve;
    }));
    const oldRequest = opencodeClient.checkHealth();

    setRuntimeBase('/next/api');
    opencodeClient.reconnectToRuntimeBaseUrl();
    resolveHealth(new Response(JSON.stringify({ healthy: true }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(await oldRequest).toBe(false);

    expect(await opencodeClient.checkHealth()).toBe(true);
    expect(healthFetchCalls.length).toBe(2);
  });
});
