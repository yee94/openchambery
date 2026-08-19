import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ConfigEntry = { type: 'document'; info: Record<string, unknown> };

(mock as unknown as { restore?: () => void }).restore?.();

const configResolvers: Array<(entries: ConfigEntry[]) => void> = [];
let configCalls = 0;
let runtimeKey = 'test-runtime';
let runtimeBase = '/api';
const healthFetchCalls: unknown[][] = [];
const healthFetchResults: Array<Response | Error | Promise<Response>> = [];
const agentSdkCalls: unknown[][] = [];
const sessionStatusSdkCalls: unknown[][] = [];
const sessionActiveSdkCalls: unknown[][] = [];
const sessionActiveResults: Array<unknown> = [];
const sdkClientConfigs: Array<unknown> = [];

const sessionActiveMock = mock(async (...args: unknown[]) => {
  sessionActiveSdkCalls.push(args);
  const next = sessionActiveResults.shift();
  if (next instanceof Error) throw next;
  return next ?? {};
});

const sessionDiffSdkCalls: unknown[][] = [];
const constructorConfigs: unknown[] = [];

mock.module('@opencode-ai/client', () => ({
  OpenCode: {
    make: mock((config: unknown) => {
      sdkClientConfigs.push(config);
      constructorConfigs.push(config);
      return {
        config: {
          get: mock(() => {
            configCalls += 1;
            return new Promise<ConfigEntry[]>((resolve) => {
              configResolvers.push(resolve);
            });
          }),
        },
        agent: {
          list: mock((...args: unknown[]) => {
            agentSdkCalls.push(args);
            return Promise.resolve({ data: [{ id: 'build', name: 'build', mode: 'primary', hidden: false, permissions: [], request: { settings: {}, headers: {}, body: {} } }] });
          }),
        },
        session: {
          active: sessionActiveMock,
        },
        permission: {
          get: mock(async () => ({ id: 'perm_1', sessionID: 'ses_1', action: 'bash', resources: ['*'] })),
          request: { list: mock(async () => ({ data: [] })) },
          create: mock(async () => ({ id: 'perm_1', effect: 'ask' })),
        },
        question: {
          request: { list: mock(async () => ({ data: [] })) },
        },
        provider: {
          list: mock(async () => ({ data: [] })),
        },
        model: {
          default: mock(async () => ({ data: null })),
        },
      };
    }),
  },
  ClientError: class ClientError extends Error {
    reason: string;
    constructor(reason: string, options?: ErrorOptions) {
      super(reason, options);
      this.name = 'ClientError';
      this.reason = reason;
    }
  },
  isPermissionNotFoundError: (value: unknown) =>
    !!value && typeof value === 'object' && (value as { _tag?: unknown })._tag === 'PermissionNotFoundError',
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: (path: string) => path === '/' ? (runtimeBase.replace(/\/api$/, '') || '/') : runtimeBase,
  })),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: mock(() => ''),
  getRuntimeKey: mock(() => runtimeKey),
  isRuntimeInstanceChange: mock(() => false),
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

const uploadPromptAttachmentCalls: Array<{ mime: string; filename?: string }> = [];
const uploadPromptAttachmentBytesMock = mock(async (input: { mime: string; filename?: string }) => {
  uploadPromptAttachmentCalls.push(input);
  return {
    path: '/data/openchamber/prompt-attachments/ab/uploaded.bin',
    url: 'file:///data/openchamber/prompt-attachments/ab/uploaded.bin',
    mime: input.mime,
    size: 4,
    sha256: 'deadbeef',
  };
});

mock.module('@/lib/prompt-attachment-upload', () => ({
  MAX_PROMPT_ATTACHMENT_BYTES: 25 * 1024 * 1024,
  toPromptAttachmentFileUrl: (filepath: string) => `file://${filepath}`,
  pathFromPromptAttachmentFileUrl: (url: string) => url.replace(/^file:\/\//, ''),
  needsPromptAttachmentUpload: (url: string) => url.startsWith('data:') || url.startsWith('blob:'),
  blobFromDataUrl: (url: string, mime: string) => new Blob(['ok'], { type: mime || 'application/octet-stream' }),
  uploadPromptAttachmentBytes: uploadPromptAttachmentBytesMock,
}));

const { opencodeClient } = await import(`./client?cache-test=${Date.now()}`);

beforeEach(() => {
  healthFetchCalls.length = 0;
  healthFetchResults.length = 0;
  uploadPromptAttachmentCalls.length = 0;
  agentSdkCalls.length = 0;
  sessionStatusSdkCalls.length = 0;
  sessionActiveSdkCalls.length = 0;
  sessionActiveResults.length = 0;
  sessionDiffSdkCalls.length = 0;
  sdkClientConfigs.length = 0;
  uploadPromptAttachmentCalls.length = 0;
  runtimeKey = 'test-runtime';
  runtimeBase = '/api';
});

describe('opencodeClient v2 make()', () => {
  test('constructs the promise client with origin baseUrl and runtimeFetch', () => {
    const created = constructorConfigs[0] as { baseUrl: string; fetch?: unknown };
    expect(created.fetch).toBe(runtimeFetchMock);
    expect(created.baseUrl === '/' || created.baseUrl.endsWith('/') || !created.baseUrl.endsWith('/api')).toBe(true);
    expect(created.baseUrl.endsWith('/api')).toBe(false);
  });
});

describe('opencodeClient abort signals', () => {
  test('passes signals to scoped SDK catalog requests', async () => {
    const controller = new AbortController();

    await opencodeClient.listAgents('/workspace/project', controller.signal);

    const passed = (agentSdkCalls[0]?.[1] as { signal?: AbortSignal } | undefined)?.signal;
    expect(passed).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(passed?.aborted).toBe(true);
    expect(agentSdkCalls[0]?.[0]).toEqual({ location: { directory: '/workspace/project' } });
  });

  test('does not call a 1.x session.status endpoint', async () => {
    const statusSignal = new AbortController().signal;
    const result = await opencodeClient.getSessionStatusForDirectory('/workspace/project', statusSignal);
    expect(result).toBeNull();
    expect(sessionStatusSdkCalls).toEqual([]);
  });

  test('passes signals to session.active requests', async () => {
    const activeSignal = new AbortController().signal;
    await opencodeClient.getSessionActive(activeSignal);
    expect(sessionActiveSdkCalls[0]).toEqual([{ signal: activeSignal }]);
  });
});

describe('opencodeClient V2 runtime base', () => {
  test('uses the runtime origin so V2 session.active supplies its own API prefix', async () => {
    runtimeBase = 'https://runtime.example/api';
    opencodeClient.reconnectToRuntimeBaseUrl();

    await opencodeClient.getSessionActive();

    expect((sdkClientConfigs.at(-1) as { baseUrl: string }).baseUrl).toBe('https://runtime.example');
  });
});

describe('opencodeClient getSessionDiff', () => {
  test('fails closed because v2 has no session.diff client method', async () => {
    let thrown: unknown;
    try {
      await opencodeClient.getSessionDiff({
        sessionID: 'ses_1',
        directory: '/workspace/project',
        messageID: 'msg_user',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error).toBe(true);
    expect((thrown as Error).name).toBe('V2CapabilityUnavailableError');
    expect((thrown as Error).message).toContain('session.diff');
  });
});

describe('opencodeClient getSessionActive', () => {
  test('returns supported membership on 200', async () => {
    sessionActiveResults.push({ ses_a: { type: 'running' } });

    expect(await opencodeClient.getSessionActive()).toEqual({
      state: 'supported',
      membership: { ses_a: { type: 'running' } },
    });
  });

  test('returns unsupported on 404/405/501', async () => {
    const { ClientError } = await import('@opencode-ai/client');
    for (const status of [404, 405, 501]) {
      sessionActiveResults.push(new ClientError('UnexpectedStatus', { cause: { status } }));
      expect(await opencodeClient.getSessionActive()).toEqual({ state: 'unsupported' });
    }
  });

  test('returns unknown on 5xx, network, and malformed 200', async () => {
    const { ClientError } = await import('@opencode-ai/client');
    sessionActiveResults.push(new ClientError('UnexpectedStatus', { cause: { status: 500 } }));
    expect(await opencodeClient.getSessionActive()).toEqual({ state: 'unknown' });

    sessionActiveResults.push(new TypeError('Failed to fetch'));
    expect(await opencodeClient.getSessionActive()).toEqual({ state: 'unknown' });

    sessionActiveResults.push({ ses_a: { type: 'not-running' } });
    expect(await opencodeClient.getSessionActive()).toEqual({ state: 'unknown' });
  });
});

describe('opencodeClient getConfig cache', () => {
  test('cleared stale in-flight requests do not repopulate cache or delete newer in-flight requests', async () => {
    const first = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(1);

    opencodeClient.clearConfigCache();

    const second = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[0]?.([{ type: 'document', info: { model: 'old/model' } }]);
    expect(await first).toEqual({ model: 'old/model' });

    const third = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[1]?.([{ type: 'document', info: { model: 'new/model' } }]);
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
    healthFetchResults.push(new Response('gateway timeout', { status: 504 }));

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-504');
    } catch (caught) {
      error = caught;
    }

    expect(healthFetchCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (504)');
  });

  test('does not retry transport failures because the tunnel may have lost only the response', async () => {
    healthFetchResults.push(new TypeError('Failed to fetch'));

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-network');
    } catch (caught) {
      error = caught;
    }

    expect(healthFetchCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to fetch');
  });

  test('does not fabricate an HTTP 500 when the SDK swallows a transport failure into result.error', async () => {
    // The SDK catches thrown fetch errors and returns { error, response: undefined }.
    // That is a transport failure, not a server 500 — it must surface as a
    // descriptive transport error, never as "Failed to send message (500): {}".
    healthFetchResults.push(new TypeError('relay tunnel reset: plaintext frame on established channel'));

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-transport');
    } catch (caught) {
      error = caught;
    }

    expect(healthFetchCalls.length).toBe(1);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('Failed to send message (500)');
    expect(message).toContain('relay tunnel reset');
    expect((error as Error & { status?: number }).status).toBe(undefined);
  });

  test('does not retry 503 prompt responses because proxy errors can be ambiguous too', async () => {
    healthFetchResults.push(new Response('starting', { status: 503 }));

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-503');
    } catch (caught) {
      error = caught;
    }

    expect(healthFetchCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (503)');
  });

  const readPromptRequestBody = (callIndex = 0): { text?: string; files?: Array<{ uri?: string; name?: string }> } => {
    const init = (healthFetchCalls[callIndex]?.[1] ?? {}) as { body?: string };
    return JSON.parse(init.body ?? '{}');
  };

  test('uploads inline data URLs before the prompt POST so the JSON body stays a file:// reference', async () => {
    healthFetchResults.push(new Response(JSON.stringify({ id: 'inbox_1', sessionID: 'ses_1' }), { headers: { 'Content-Type': 'application/json' } }));

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
    const body = readPromptRequestBody();
    expect(body.files?.some((file) => file.uri === 'file:///data/openchamber/prompt-attachments/ab/uploaded.bin' && file.name === 'photo.png')).toBe(true);
    expect(body.files?.some((file) => file.uri?.startsWith('data:'))).toBe(false);
  });

  test('expands image citations to the uploaded host path in authored text', async () => {
    healthFetchResults.push(new Response(JSON.stringify({ id: 'inbox_1', sessionID: 'ses_1' }), { headers: { 'Content-Type': 'application/json' } }));

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

    const body = readPromptRequestBody();
    expect(body.text).toBe('[/data/openchamber/prompt-attachments/ab/uploaded.bin] what is this');
    expect(body.files?.some((file) => file.uri === 'file:///data/openchamber/prompt-attachments/ab/uploaded.bin')).toBe(true);
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

describe('opencodeClient v2 capability unavailable', () => {
  test('listToolIds / updateConfig / getSessionTodos / deleteSessionMessage fail closed', async () => {
    const cases = [
      () => opencodeClient.listToolIds(),
      () => opencodeClient.updateConfig({ model: 'x' }),
      () => opencodeClient.getSessionTodos('ses_1'),
      () => opencodeClient.deleteSessionMessage('ses_1', 'msg_1'),
    ];
    for (const run of cases) {
      let thrown: unknown;
      try {
        await run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown instanceof Error).toBe(true);
      expect((thrown as Error).name).toBe('V2CapabilityUnavailableError');
    }
  });
});
