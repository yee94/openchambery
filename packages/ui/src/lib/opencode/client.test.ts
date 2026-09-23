import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ConfigEntry = { type: 'document'; info: Record<string, unknown> };

(mock as unknown as { restore?: () => void }).restore?.();

const configResolvers: Array<(entries: ConfigEntry[]) => void> = [];
let configCalls = 0;
let runtimeKey = 'test-runtime';
let runtimeBase = '/api';
let runtimeGeneration = 1;
const healthFetchCalls: unknown[][] = [];
const healthFetchResults: Array<Response | Error | Promise<Response>> = [];
const sessionUpdateSdkCalls: unknown[][] = [];
const sessionGetSdkCalls: unknown[][] = [];
const sessionUpdateResults: Array<unknown> = [];
const sessionGetResults: Array<unknown> = [];
const agentSdkCalls: unknown[][] = [];
const agentListResults: Array<unknown> = [];
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

const sessionGenerateSdkCalls: unknown[][] = [];
const sessionGenerateResults: Array<unknown> = [];
const sessionGenerateMock = mock(async (...args: unknown[]) => {
  sessionGenerateSdkCalls.push(args);
  const next = sessionGenerateResults.shift();
  if (next instanceof Error) throw next;
  return next ?? { text: 'aside' };
});

const sessionDiffSdkCalls: unknown[][] = [];
const constructorConfigs: unknown[] = [];

mock.module('@opencode/client', () => ({
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
            const next = agentListResults.shift();
            if (next instanceof Error) return Promise.reject(next);
            if (next) return Promise.resolve(next);
            // Official wire shape: id is machine key, name is display label.
            return Promise.resolve({
              data: [{
                id: 'build',
                name: 'Build',
                mode: 'primary',
                hidden: false,
                permissions: [],
                request: { settings: {}, headers: {}, body: {} },
              }],
            });
          }),
        },
        session: {
          active: sessionActiveMock,
          generate: sessionGenerateMock,
          update: mock(async (...args: unknown[]) => {
            sessionUpdateSdkCalls.push(args);
            const next = sessionUpdateResults.shift();
            if (next instanceof Error) throw next;
            return next ?? { id: 'ses_1', title: 'updated' };
          }),
          get: mock(async (...args: unknown[]) => {
            sessionGetSdkCalls.push(args);
            const next = sessionGetResults.shift();
            if (next instanceof Error) throw next;
            return next ?? {
              id: 'ses_1',
              title: 'updated',
              location: { directory: '/repo' },
              time: { created: 1, updated: 2 },
            };
          }),
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
  getRuntimeTransportIdentity: mock(() => runtimeKey),
  getRuntimeGeneration: mock(() => runtimeGeneration),
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
type UploadResult = {
  path: string
  url: string
  mime: string
  size: number
  sha256: string
}
const uploadPromptAttachmentResults: Array<UploadResult | Promise<UploadResult>> = [];
const defaultUploadResult = (mime: string): UploadResult => ({
  path: '/data/openchamber/prompt-attachments/ab/uploaded.bin',
  url: 'file:///data/openchamber/prompt-attachments/ab/uploaded.bin',
  mime,
  size: 4,
  sha256: 'deadbeef',
});
const uploadPromptAttachmentBytesMock = mock(async (input: { mime: string; filename?: string }) => {
  uploadPromptAttachmentCalls.push(input);
  const next = uploadPromptAttachmentResults.shift();
  if (next) return await next;
  return defaultUploadResult(input.mime);
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
  uploadPromptAttachmentResults.length = 0;
  agentSdkCalls.length = 0;
  agentListResults.length = 0;
  sessionStatusSdkCalls.length = 0;
  sessionActiveSdkCalls.length = 0;
  sessionActiveResults.length = 0;
  sessionGenerateSdkCalls.length = 0;
  sessionGenerateResults.length = 0;
  sessionDiffSdkCalls.length = 0;
  sessionUpdateSdkCalls.length = 0;
  sessionGetSdkCalls.length = 0;
  sessionUpdateResults.length = 0;
  sessionGetResults.length = 0;
  sdkClientConfigs.length = 0;
  uploadPromptAttachmentCalls.length = 0;
  runtimeKey = 'test-runtime';
  runtimeBase = '/api';
  runtimeGeneration = 1;
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

  test('listAgents projects wire id Build display onto domain name=id for prompts', async () => {
    agentListResults.push({
      data: [
        {
          id: 'build',
          name: 'Build',
          mode: 'primary',
          hidden: false,
          permissions: [],
          request: { settings: {}, headers: {}, body: {} },
        },
        {
          id: 'plan',
          name: 'Plan',
          mode: 'primary',
          hidden: false,
          permissions: [],
          request: { settings: {}, headers: {}, body: {} },
        },
      ],
    });

    const agents = await opencodeClient.listAgents('/workspace/project');
    expect(agents.map((agent: { id: string; name: string; displayName: string }) => ({
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
    }))).toEqual([
      { id: 'build', name: 'build', displayName: 'Build' },
      { id: 'plan', name: 'plan', displayName: 'Plan' },
    ]);
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

describe('opencodeClient generateSessionAside', () => {
  test('calls session.generate with body and AbortSignal without mutating currentDirectory', async () => {
    const controller = new AbortController();
    sessionGenerateResults.push({ text: '  side answer  ' });

    const previousDirectory = opencodeClient.getDirectory();
    opencodeClient.setDirectory('/other');
    try {
      const result = await opencodeClient.generateSessionAside({
        sessionId: 'ses_btw',
        directory: '/workspace/project',
        prompt: 'instructions\n\nquestion',
        signal: controller.signal,
      });

      expect(result).toEqual({ text: '  side answer  ' });
      expect(sessionGenerateSdkCalls).toHaveLength(1);
      expect(sessionGenerateSdkCalls[0]?.[0]).toEqual({
        sessionID: 'ses_btw',
        prompt: 'instructions\n\nquestion',
      });
      expect(sessionGenerateSdkCalls[0]?.[1]).toEqual({ signal: controller.signal });
      // Public contract: generateSessionAside never mutates currentDirectory.
      expect(opencodeClient.getDirectory()).toBe('/other');
    } finally {
      opencodeClient.setDirectory(previousDirectory);
    }
  });

  test('does not block concurrent generates or withDirectory while in flight', async () => {
    let resolveFirst: ((value: { text: string }) => void) | undefined;
    let resolveSecond: ((value: { text: string }) => void) | undefined;
    sessionGenerateResults.push(
      new Promise<{ text: string }>((resolve) => {
        resolveFirst = resolve;
      }),
      new Promise<{ text: string }>((resolve) => {
        resolveSecond = resolve;
      }),
    );

    const previousDirectory = opencodeClient.getDirectory();
    opencodeClient.setDirectory('/baseline');
    try {
      const first = opencodeClient.generateSessionAside({
        sessionId: 'ses_a',
        directory: '/dir-a',
        prompt: 'prompt-a',
        signal: new AbortController().signal,
      });
      // Second generate must start before first settles (no directoryContextQueue).
      const second = opencodeClient.generateSessionAside({
        sessionId: 'ses_b',
        directory: '/dir-b',
        prompt: 'prompt-b',
        signal: new AbortController().signal,
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sessionGenerateSdkCalls).toHaveLength(2);
      expect(sessionGenerateSdkCalls[0]?.[0]).toEqual({ sessionID: 'ses_a', prompt: 'prompt-a' });
      expect(sessionGenerateSdkCalls[1]?.[0]).toEqual({ sessionID: 'ses_b', prompt: 'prompt-b' });
      const firstOptions = sessionGenerateSdkCalls[0]?.[1] as { signal?: AbortSignal } | undefined;
      const secondOptions = sessionGenerateSdkCalls[1]?.[1] as { signal?: AbortSignal } | undefined;
      expect(firstOptions?.signal).toBeInstanceOf(AbortSignal);
      expect(secondOptions?.signal).toBeInstanceOf(AbortSignal);

      // withDirectory must not wait on the in-flight generate.
      let withDirectoryStarted = false;
      const withDirectoryDone = opencodeClient.withDirectory('/dir-c', async () => {
        withDirectoryStarted = true;
        return 'ok';
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(withDirectoryStarted).toBe(true);
      expect(await withDirectoryDone).toBe('ok');

      // External currentDirectory mutation after capture must not rewrite request bodies.
      opencodeClient.setDirectory('/mutated-after-capture');
      resolveFirst?.({ text: 'a' });
      resolveSecond?.({ text: 'b' });
      expect(await first).toEqual({ text: 'a' });
      expect(await second).toEqual({ text: 'b' });
      expect(sessionGenerateSdkCalls[0]?.[0]).toEqual({ sessionID: 'ses_a', prompt: 'prompt-a' });
      expect(sessionGenerateSdkCalls[1]?.[0]).toEqual({ sessionID: 'ses_b', prompt: 'prompt-b' });
      expect(opencodeClient.getDirectory()).toBe('/mutated-after-capture');
    } finally {
      opencodeClient.setDirectory(previousDirectory);
    }
  });

  test('throws when sessionId is missing or payload is invalid', async () => {
    await expect(opencodeClient.generateSessionAside({
      sessionId: '  ',
      prompt: 'x',
    })).rejects.toThrow('generateSessionAside requires sessionId');

    sessionGenerateResults.push({ text: 1 });
    await expect(opencodeClient.generateSessionAside({
      sessionId: 'ses_1',
      prompt: 'x',
    })).rejects.toThrow('session.generate returned invalid payload');
  });

  test('propagates SDK failures instead of empty success', async () => {
    sessionGenerateResults.push(new Error('generate unavailable'));
    await expect(opencodeClient.generateSessionAside({
      sessionId: 'ses_1',
      prompt: 'x',
    })).rejects.toThrow('generate unavailable');
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
  test('fetches the v2 session diff route through runtimeFetch', async () => {
    healthFetchResults.push(new Response(JSON.stringify({ data: [{ file: 'a.ts' }] }), {
      headers: { 'Content-Type': 'application/json' },
    }));

    const diffs = await opencodeClient.getSessionDiff({
      sessionID: 'ses_1',
      directory: '/workspace/project',
      messageID: 'msg_user',
    });

    expect(diffs).toEqual([{ file: 'a.ts' }]);
    const [url] = healthFetchCalls.at(-1) as [string];
    expect(url).toContain('/session/ses_1/diff');
    expect(url).toContain('directory=');
    expect(url).toContain('messageID=msg_user');
  });

  test('passes AbortSignal to the transport and fails closed on non-2xx', async () => {
    const signal = new AbortController().signal;
    healthFetchResults.push(new Response(null, { status: 500 }));

    await expect(opencodeClient.getSessionDiff({ sessionID: 'ses_1' }, { signal })).rejects.toThrow('session.diff failed (500)');

    const [, init] = healthFetchCalls.at(-1) as [string, RequestInit];
    expect(init.signal).toBe(signal);
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
    const { ClientError } = await import('@opencode/client');
    for (const status of [404, 405, 501]) {
      sessionActiveResults.push(new ClientError('UnexpectedStatus', { cause: { status } }));
      expect(await opencodeClient.getSessionActive()).toEqual({ state: 'unsupported' });
    }
  });

  test('returns unknown on 5xx, network, and malformed 200', async () => {
    const { ClientError } = await import('@opencode/client');
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

  const emptyJson = () => new Response(JSON.stringify({ data: [] }), {
    headers: { 'Content-Type': 'application/json' },
  });

  test('ambiguous 504: fixed-id reconcile then one prompt-only retry (never silent empty success)', async () => {
    // POST fail → inbox GET empty → projection empty → POST retry fail → reconcile again
    healthFetchResults.push(new Response('gateway timeout', { status: 504 }));
    healthFetchResults.push(emptyJson());
    healthFetchResults.push(emptyJson());
    healthFetchResults.push(new Response('gateway timeout', { status: 504 }));
    healthFetchResults.push(emptyJson());
    healthFetchResults.push(emptyJson());

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-504');
    } catch (caught) {
      error = caught;
    }

    expect(healthFetchCalls.length).toBeGreaterThanOrEqual(2);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (504)');
  });

  test('transport loss: reconciles fixed id from inbox without minting a new input', async () => {
    healthFetchResults.push(new TypeError('Failed to fetch'));
    healthFetchResults.push(new Response(JSON.stringify({
      data: [{
        id: 'msg_fixed_recon',
        sessionID: 'ses_1',
        timeCreated: 1,
        type: 'user',
        delivery: 'steer',
        payload: { text: 'hello' },
      }],
    }), { headers: { 'Content-Type': 'application/json' } }));

    const admitted = await opencodeClient.sendMessage({
      id: 'ses_1',
      providerID: 'anthropic-recon',
      modelID: 'claude-sonnet',
      text: 'hello',
      messageId: 'msg_fixed_recon',
    });
    expect(admitted).toBe('msg_fixed_recon');
    // One failed POST + one inbox GET reconcile — no second prompt POST.
    const promptPosts = healthFetchCalls.filter((call) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      const method = (call[1] as { method?: string } | undefined)?.method ?? 'GET';
      return method === 'POST' && url.includes('/prompt');
    });
    expect(promptPosts).toHaveLength(1);
  });

  test('does not fabricate an HTTP 500 when transport fails after bounded reconcile', async () => {
    healthFetchResults.push(new TypeError('relay tunnel reset: plaintext frame on established channel'));
    healthFetchResults.push(emptyJson());
    healthFetchResults.push(emptyJson());
    healthFetchResults.push(new TypeError('relay tunnel reset: plaintext frame on established channel'));
    healthFetchResults.push(emptyJson());
    healthFetchResults.push(emptyJson());

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-transport');
    } catch (caught) {
      error = caught;
    }

    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('Failed to send message (500)');
    expect(message).toContain('relay tunnel reset');
    expect((error as Error & { status?: number }).status).toBe(undefined);
  });

  test('explicit 400 reject is not retried', async () => {
    healthFetchResults.push(new Response('bad request', { status: 400 }));

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-400');
    } catch (caught) {
      error = caught;
    }

    expect(healthFetchCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (400)');
  });

  test('queue delivery does not POST session model switch before prompt', async () => {
    healthFetchResults.push(new Response(JSON.stringify({
      id: 'msg_q1',
      sessionID: 'ses_1',
      timeCreated: 1,
      type: 'user',
      delivery: 'queue',
      payload: { text: 'later' },
    }), { headers: { 'Content-Type': 'application/json' } }));

    await opencodeClient.sendMessage({
      id: 'ses_1',
      providerID: 'anthropic-queue',
      modelID: 'claude-sonnet',
      text: 'later',
      delivery: 'queue',
      switchModel: { id: 'other-model', providerID: 'anthropic-queue' },
      switchAgent: 'plan',
      messageId: 'msg_q1',
    });

    const paths = healthFetchCalls.map((call) => {
      const url = call[0];
      return typeof url === 'string' ? url : String(url);
    });
    expect(paths.some((path) => path.includes('/prompt'))).toBe(true);
    expect(paths.some((path) => path.includes('/model') || path.includes('switchModel'))).toBe(false);
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

  for (const delivery of ['steer', 'queue'] as const) test(`sends canonical skills as native attachments for ${delivery} delivery`, async () => {
    healthFetchResults.push(new Response(JSON.stringify({ id: 'msg_skill', sessionID: 'ses_1' }), { headers: { 'Content-Type': 'application/json' } }));
    await opencodeClient.sendMessage({
      id: 'ses_1', providerID: 'skill-test', modelID: 'model', messageId: 'msg_skill',
      text: '[skill:release] prepare notes [skill:release]', delivery,
      additionalParts: [{ text: '[skill:synthetic-example]', synthetic: true }],
    });
    expect(readPromptRequestBody()).toMatchObject({
      skills: [{ id: 'release', name: 'release' }], delivery,
    });
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

  test('discards send when runtime generation advances during attachment upload', async () => {
    let resolveUpload: (value: UploadResult) => void = () => undefined
    uploadPromptAttachmentResults.push(new Promise((resolve) => {
      resolveUpload = resolve
    }))

    const pending = opencodeClient.sendMessage({
      id: 'ses_1',
      providerID: 'anthropic-upload-stale',
      modelID: 'claude-sonnet',
      text: 'photo',
      files: [{
        type: 'file',
        mime: 'image/png',
        filename: 'photo.png',
        url: 'data:image/png;base64,aGVsbA==',
      }],
    })

    runtimeGeneration = 2
    resolveUpload(defaultUploadResult('image/png'))

    let thrown: unknown
    try {
      await pending
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error)?.name).toBe('RuntimeGenerationMismatchError')
    expect(healthFetchCalls.some((call) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0])
      return url.includes('/prompt')
    })).toBe(false)
  })

  test('discards late prompt HTTP parse after runtime generation advances', async () => {
    let resolveFetch: (response: Response) => void = () => undefined
    healthFetchResults.push(new Promise((resolve) => {
      resolveFetch = resolve
    }))

    const pending = opencodeClient.sendMessage({
      id: 'ses_1',
      providerID: 'anthropic-late-http',
      modelID: 'claude-sonnet',
      text: 'hello',
      messageId: 'msg_late_http',
    })

    runtimeGeneration = 9
    resolveFetch(new Response(JSON.stringify({
      id: 'msg_late_http',
      sessionID: 'ses_1',
      timeCreated: 1,
      type: 'user',
      delivery: 'steer',
      payload: { text: 'hello' },
    }), { headers: { 'Content-Type': 'application/json' } }))

    let thrown: unknown
    try {
      await pending
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error)?.name).toBe('RuntimeGenerationMismatchError')
  })
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

describe('opencodeClient updateSession Host archive facade', () => {
  test('archives via PUT Host /archive and projects the session response', async () => {
    healthFetchResults.push(new Response(JSON.stringify({
      session: {
        id: 'ses_1',
        title: 'Archived',
        location: { directory: '/repo/app' },
        time: { created: 1, updated: 2, archived: 99 },
        metadata: { openchamber: { archive: { archivedAt: 99 } } },
      },
    }), { headers: { 'Content-Type': 'application/json' } }));

    const session = await opencodeClient.updateSession(
      'ses_1',
      { time: { archived: 99 } },
      '/repo/app',
    );

    expect(session.id).toBe('ses_1');
    expect(session.directory).toBe('/repo/app');
    expect(session.time?.archived).toBe(99);
    expect(session.metadata).toEqual({ openchamber: { archive: { archivedAt: 99 } } });

    const [url, init] = healthFetchCalls.at(-1) as [string, RequestInit];
    expect(url).toContain('/openchamber/sessions/ses_1/archive');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ archivedAt: 99, directory: '/repo/app' });
  });

  test('normalizes null archive cancel to archivedAt 0', async () => {
    healthFetchResults.push(new Response(JSON.stringify({
      session: {
        id: 'ses_1',
        location: { directory: '/repo' },
        time: { created: 1, updated: 2 },
        metadata: { openchamber: { archive: { archivedAt: 0 } } },
      },
    }), { headers: { 'Content-Type': 'application/json' } }));

    const session = await opencodeClient.updateSession('ses_1', { time: { archived: null } }, '/repo');
    expect(session.time?.archived).toBeUndefined();
    const [, init] = healthFetchCalls.at(-1) as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ archivedAt: 0, directory: '/repo' });
  });

  test('discards late archive responses after runtime generation changes', async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    healthFetchResults.push(new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const pending = opencodeClient.updateSession('ses_1', { time: { archived: 50 } }, '/repo');
    runtimeGeneration = 2;
    resolveFetch(new Response(JSON.stringify({
      session: {
        id: 'ses_1',
        time: { created: 1, updated: 2, archived: 50 },
      },
    }), { headers: { 'Content-Type': 'application/json' } }));

    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error).toBe(true);
    expect((thrown as Error).name).toBe('RuntimeGenerationMismatchError');
  });

  test('composes title then archive and reports partial failure when archive fails', async () => {
    sessionUpdateResults.push({ id: 'ses_1', title: 'Renamed' });
    sessionGetResults.push({
      id: 'ses_1',
      title: 'Renamed',
      location: { directory: '/repo' },
      time: { created: 1, updated: 2 },
    });
    healthFetchResults.push(new Response(JSON.stringify({ error: 'nope' }), { status: 503 }));

    let thrown: unknown;
    try {
      await opencodeClient.updateSession(
        'ses_1',
        { title: 'Renamed', time: { archived: 10 } },
        '/repo',
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof Error).toBe(true);
    expect((thrown as Error).name).toBe('SessionUpdatePartialFailureError');
    expect((thrown as Error).message).toContain('after title');
    expect((thrown as Error & { completed?: string[] }).completed).toEqual(['title']);
    expect(sessionUpdateSdkCalls.length).toBe(1);
  });

  test('fails closed on non-2xx archive without treating empty as success', async () => {
    healthFetchResults.push(new Response(null, { status: 500 }));
    await expect(
      opencodeClient.updateSession('ses_1', { time: { archived: 1 } }),
    ).rejects.toThrow('session.archive update failed (500)');
  });
});
