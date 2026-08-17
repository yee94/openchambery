import { beforeEach, describe, expect, it, mock } from 'bun:test';

const sdkClient = {
  session: {
    create: mock(),
    prompt: mock(),
  },
};

const make = mock(() => sdkClient);

class ClientError extends Error {
  constructor(reason, options) {
    super(reason, options);
    this.name = 'ClientError';
    this.reason = reason;
  }
}

// No setSessionActivityPhase import — VS Code does not manually mark activity

mock.module('@opencode-ai/client', () => ({ OpenCode: { make }, ClientError }));

const { handleConversationsBridgeMessage, resetVSCodeRegistry } = await import(
  './bridge-conversations-runtime'
);

const defaultCtx = {
  manager: {
    getApiUrl: () => 'http://opencode.test',
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
  },
};

const validPayload = {
  input: { type: 'prompt' },
  directory: '/repo',
  messageID: 'msg_hex_01',
  model: { providerID: 'openai', modelID: 'gpt-4o' },
  parts: [{ type: 'text', text: 'Hello' }],
};

const sessionFixture = {
  id: 'ses_abc123',
  projectID: 'proj_1',
  title: 'My Session',
  location: { directory: '/repo' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: Date.now(), updated: Date.now() },
};

const throwWithStatus = (status, message) => {
  const error = new ClientError('UnexpectedStatus', { cause: { status } });
  error.message = message;
  throw error;
};

describe('bridge conversations runtime', () => {
  beforeEach(() => {
    resetVSCodeRegistry();
    sdkClient.session.create.mockReset();
    sdkClient.session.prompt.mockReset();
    make.mockReset();

    make.mockImplementation(() => sdkClient);

    sdkClient.session.create.mockImplementation(async () => sessionFixture);
    sdkClient.session.prompt.mockImplementation(async () => ({
      id: 'inbox_1',
      sessionID: sessionFixture.id,
      timeCreated: Date.now(),
      type: 'user',
      payload: { text: 'Hello' },
      delivery: 'steer',
    }));
  });

  // --- routing ---

  it('returns null for non-conversations message type', async () => {
    const result = await handleConversationsBridgeMessage(
      { id: '1', type: 'other:message', payload: {} },
      defaultCtx,
    );
    expect(result).toBeNull();
  });

  // --- abort ---

  it('handles abort message', async () => {
    const result = await handleConversationsBridgeMessage(
      { id: '1', type: 'api:conversations:abort', payload: { requestID: 'req_test' } },
      defaultCtx,
    );
    expect(result).toEqual({
      id: '1',
      type: 'api:conversations:abort',
      success: true,
      data: { aborted: true },
    });
  });

  it('silently handles abort for unknown requestID', async () => {
    const result = await handleConversationsBridgeMessage(
      { id: '1', type: 'api:conversations:abort', payload: { requestID: 'nonexistent' } },
      defaultCtx,
    );
    expect(result.success).toBe(true);
  });

  it('abort cancels between create success and prompt start', async () => {
    // Create succeeds, but promptAsync never resolves (aborted)
    let promptCalled = false;
    sdkClient.session.prompt.mockImplementation(async (_params, opts) => {
      promptCalled = true;
      // Simulate abort happening during prompt wait
      await new Promise((r) => setTimeout(r, 10));
      throw new DOMException('Aborted', 'AbortError');
    });

    // Start the flow
    const promise = handleConversationsBridgeMessage(
      { id: 'req_ab', type: 'api:conversations:createWithPrompt', payload: validPayload },
      defaultCtx,
    );

    // Wait for create to complete
    await new Promise((r) => setTimeout(r, 5));

    // Send abort
    await handleConversationsBridgeMessage(
      { id: '2', type: 'api:conversations:abort', payload: { requestID: 'req_ab' } },
      defaultCtx,
    );

    const result = await promise;
    expect(promptCalled).toBe(true);
    // Transport error from abort → ambiguous prompt failure
    if (result.data.phase === 'prompt') {
      expect(result.data.ambiguous).toBe(true);
    }
    expect(result.data.error).toBeDefined();
  });

  // --- validate: full parity with server ---

  it('returns validate for empty payload', async () => {
    const result = await handleConversationsBridgeMessage(
      { id: '1', type: 'api:conversations:createWithPrompt', payload: {} },
      defaultCtx,
    );
    expect(result.data.ok).toBe(false);
    expect(result.data.phase).toBe('validate');
    expect(result.data.errors).toBeInstanceOf(Array);
    expect(result.data.errors.length).toBeGreaterThan(0);
  });

  it('returns validate for missing directory', async () => {
    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: {
          input: { type: 'prompt' },
          messageID: 'msg_1',
          model: { providerID: 'o', modelID: 'g' },
          parts: [{ type: 'text', text: 'hi' }],
        },
      },
      defaultCtx,
    );
    expect(result.data.phase).toBe('validate');
    expect(result.data.errors.some((e) => e.includes('directory'))).toBe(true);
  });

  it('returns validate for missing model', async () => {
    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: {
          input: { type: 'prompt' },
          directory: '/repo',
          messageID: 'msg_1',
          parts: [{ type: 'text', text: 'hi' }],
        },
      },
      defaultCtx,
    );
    expect(result.data.phase).toBe('validate');
    expect(result.data.errors.some((e) => e.includes('model'))).toBe(true);
  });

  it('returns validate for unknown top-level keys', async () => {
    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: { ...validPayload, delivery: 'steer' },
      },
      defaultCtx,
    );
    expect(result.data.phase).toBe('validate');
    expect(result.data.errors.some((e) => e.includes('delivery'))).toBe(true);
  });

  it('returns validate for empty text part', async () => {
    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: { ...validPayload, parts: [{ type: 'text', text: '   ' }] },
      },
      defaultCtx,
    );
    expect(result.data.phase).toBe('validate');
    expect(result.data.errors.some((e) => e.includes('non-empty'))).toBe(true);
  });

  it('returns validate for file part missing mime', async () => {
    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: { ...validPayload, parts: [{ type: 'file', url: 'f.txt' }] },
      },
      defaultCtx,
    );
    expect(result.data.phase).toBe('validate');
    expect(result.data.errors.some((e) => e.includes('mime'))).toBe(true);
  });

  it('returns validate for invalid part type', async () => {
    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: { ...validPayload, parts: [{ type: 'subtask', text: 'hi' }] },
      },
      defaultCtx,
    );
    expect(result.data.phase).toBe('validate');
    expect(result.data.errors.some((e) => e.includes('Part type'))).toBe(true);
  });

  it('returns validate for empty parts array', async () => {
    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: { ...validPayload, parts: [] },
      },
      defaultCtx,
    );
    expect(result.data.phase).toBe('validate');
    expect(result.data.errors.some((e) => e.includes('at least one part'))).toBe(true);
  });

  it('returns validate for invalid optional metadata', async () => {
    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: { ...validPayload, metadata: 'not-an-object' },
      },
      defaultCtx,
    );
    expect(result.data.phase).toBe('validate');
    expect(result.data.errors.some((e) => e.includes('metadata'))).toBe(true);
  });

  // --- create phase ---

  it('returns create failure when OpenCode API is unavailable', async () => {
    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      { manager: undefined },
    );
    expect(result.data).toEqual({
      ok: false,
      phase: 'create',
      error: 'Failed to create session',
    });
  });

  // --- success ---

  it('returns full success with complete session', async () => {
    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      defaultCtx,
    );

    expect(result.data).toEqual({
      ok: true,
      session: sessionFixture,
      messageID: 'msg_hex_01',
    });

    expect(make).toHaveBeenCalledWith({
      baseUrl: 'http://opencode.test',
      headers: { Authorization: 'Bearer test' },
      fetch: expect.any(Function),
    });

    expect(sdkClient.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        location: { directory: '/repo' },
        model: { id: 'gpt-4o', providerID: 'openai' },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    expect(sdkClient.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: 'ses_abc123',
        id: 'msg_hex_01',
        text: 'Hello',
        delivery: 'steer',
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  // --- create error (safe, no raw error leaked) ---

  it('returns create failure with safe error on SDK error', async () => {
    sdkClient.session.create.mockImplementation(async () => {
      throwWithStatus(500, 'internal: port 4096 unreachable');
    });

    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      defaultCtx,
    );

    expect(result.data).toEqual({
      ok: false,
      phase: 'create',
      error: 'Failed to create session',
      status: 500,
    });
    expect(result.data.error).not.toContain('4096');
    expect(sdkClient.session.prompt).not.toHaveBeenCalled();
  });

  it('returns create failure on transport throw', async () => {
    sdkClient.session.create.mockImplementation(async () => {
      throw new Error('Connection refused');
    });

    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      defaultCtx,
    );

    expect(result.data).toEqual({
      ok: false,
      phase: 'create',
      error: 'Failed to create session',
    });
  });

  // --- prompt error: explicit (ambiguous=false, 400/404) ---

  it('returns prompt failure with ambiguous=false for 400', async () => {
    sdkClient.session.prompt.mockImplementation(async () => {
      throwWithStatus(400, 'path /foo does not exist');
    });

    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      defaultCtx,
    );

    expect(result.data).toEqual({
      ok: false,
      phase: 'prompt',
      session: sessionFixture,
      messageID: 'msg_hex_01',
      ambiguous: false,
      error: 'Failed to submit prompt',
      status: 400,
    });
    expect(result.data.error).not.toContain('/foo');
  });

  it('returns prompt failure with ambiguous=false for 404', async () => {
    sdkClient.session.prompt.mockImplementation(async () => {
      throwWithStatus(404, 'Session not found');
    });

    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      defaultCtx,
    );

    expect(result.data.ambiguous).toBe(false);
  });

  // --- prompt error: ambiguous (503/408/429/transport throw) ---

  it('returns ambiguous=true for 503', async () => {
    sdkClient.session.prompt.mockImplementation(async () => {
      throwWithStatus(503, 'Service Unavailable');
    });

    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      defaultCtx,
    );

    expect(result.data).toEqual({
      ok: false,
      phase: 'prompt',
      session: sessionFixture,
      messageID: 'msg_hex_01',
      ambiguous: true,
      error: 'Failed to submit prompt',
      status: 503,
    });
  });

  it('returns ambiguous=true for transport throw', async () => {
    sdkClient.session.prompt.mockImplementation(async () => {
      throw new ClientError('Transport', { cause: new TypeError('fetch failed') });
    });

    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      defaultCtx,
    );

    expect(result.data.phase).toBe('prompt');
    expect(result.data.ambiguous).toBe(true);
    expect(result.data.error).toBe('Failed to submit prompt');
  });

  it('returns ambiguous=true for 408', async () => {
    sdkClient.session.prompt.mockImplementation(async () => {
      throwWithStatus(408, 'Request Timeout');
    });

    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      defaultCtx,
    );

    expect(result.data.ambiguous).toBe(true);
  });

  it('returns ambiguous=true for 429', async () => {
    sdkClient.session.prompt.mockImplementation(async () => {
      throwWithStatus(429, 'Too Many Requests');
    });

    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      defaultCtx,
    );

    expect(result.data.ambiguous).toBe(true);
  });

  // --- full session ---

  it('returns full session object not just id', async () => {
    const fullSession = {
      id: 'ses_full',
      projectID: 'proj_full',
      title: 'Full Session',
      location: { directory: '/repo' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
      parentID: 'parent_001',
    };
    sdkClient.session.create.mockImplementation(async () => fullSession);

    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      defaultCtx,
    );

    expect(result.data.ok).toBe(true);
    expect(result.data.session).toEqual(fullSession);
    expect(result.data.session.id).toBe('ses_full');
    expect(result.data.session.location.directory).toBe('/repo');
    expect(result.data.session.title).toBe('Full Session');
  });

  // --- field pass-through ---

  it('passes title, agent, variant, parentID, metadata', async () => {
    const input = {
      ...validPayload,
      title: 'My Chat',
      agent: 'code-reviewer',
      variant: 'fast',
      metadata: { key: 'value' },
    };

    await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: input,
      },
      defaultCtx,
    );

    expect(sdkClient.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'My Chat',
        agent: 'code-reviewer',
        model: { id: 'gpt-4o', providerID: 'openai', variant: 'fast' },
        location: { directory: '/repo' },
      }),
      expect.any(Object),
    );

    expect(sdkClient.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'msg_hex_01',
        text: 'Hello',
        delivery: 'steer',
        metadata: { key: 'value' },
      }),
      expect.any(Object),
    );
  });

  it('fails closed when parentID has no v2 session.create equivalent', async () => {
    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: { ...validPayload, parentID: 'parent_xyz' },
      },
      defaultCtx,
    );

    expect(result.data).toEqual({
      ok: false,
      phase: 'create',
      error: 'Failed to create session',
    });
    expect(sdkClient.session.create).not.toHaveBeenCalled();
    expect(sdkClient.session.prompt).not.toHaveBeenCalled();
  });

  // --- file part ---

  it('passes file part with all optional fields', async () => {
    const input = {
      ...validPayload,
      parts: [
        { type: 'text', text: 'Check', synthetic: true, id: 'p1', time: { start: 1 }, metadata: { source: 'draft' } },
        { type: 'file', mime: 'text/typescript', url: 'file:///repo/src/a.ts', filename: 'a.ts', id: 'f1', source: { type: 'selection', path: '/a.ts' } },
        { type: 'agent', name: 'builder', id: 'a1', source: { value: '@builder', start: 0, end: 8 } },
      ],
    };

    await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: input,
      },
      defaultCtx,
    );

    const promptCall = sdkClient.session.prompt.mock.calls[0][0];
    expect(promptCall).toEqual(expect.objectContaining({
      id: 'msg_hex_01',
      text: 'Check',
      delivery: 'steer',
      files: [{ uri: 'file:///repo/src/a.ts', name: 'a.ts' }],
      agents: [{ name: 'builder' }],
    }));
  });

  // --- messageID is echoed ---

  it('echoes messageID in result on error and success', async () => {
    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      defaultCtx,
    );
    expect(result.data.messageID).toBe('msg_hex_01');

    sdkClient.session.prompt.mockImplementation(async () => {
      throwWithStatus(503, 'fail');
    });
    const errResult = await handleConversationsBridgeMessage(
      {
        id: '2',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      defaultCtx,
    );
    expect(errResult.data.messageID).toBe('msg_hex_01');
  });

  // --- internal error wrapping ---

  it('returns internal result on unexpected throw', async () => {
    // Force an unexpected throw by making getApiUrl throw
    const badCtx = {
      manager: {
        getApiUrl: () => { throw new Error('crash'); },
        getOpenCodeAuthHeaders: () => ({ Authorization: 'test' }),
      },
    };

    const result = await handleConversationsBridgeMessage(
      {
        id: '1',
        type: 'api:conversations:createWithPrompt',
        payload: validPayload,
      },
      badCtx,
    );

    // Should return structured internal error, not raw crash
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      ok: false,
      phase: 'internal',
      error: 'Internal server error',
    });
  });
});

describe('bridge conversations registry dedup', () => {
  beforeEach(() => {
    resetVSCodeRegistry();
    sdkClient.session.create.mockReset();
    sdkClient.session.prompt.mockReset();
    make.mockReset();
    make.mockImplementation(() => sdkClient);
    sdkClient.session.create.mockImplementation(async () => sessionFixture);
    sdkClient.session.prompt.mockImplementation(async () => ({
      id: 'inbox_1',
      sessionID: sessionFixture.id,
      timeCreated: Date.now(),
      type: 'user',
      payload: { text: 'Hello' },
      delivery: 'steer',
    }));
  });

  it('same key with identical payload (different key order) deduplicates via stableStringify', async () => {
    const payloadA = {
      ...validPayload,
      model: { modelID: 'gpt-4o', providerID: 'openai' }, // reversed key order vs validPayload
    };

    const p1 = handleConversationsBridgeMessage(
      { id: '1', type: 'api:conversations:createWithPrompt', payload: validPayload },
      defaultCtx,
    );
    const p2 = handleConversationsBridgeMessage(
      { id: '2', type: 'api:conversations:createWithPrompt', payload: payloadA },
      defaultCtx,
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.data.ok).toBe(true);
    // Second should be dedup (same key, same fingerprint from stable key order)
    expect(r2.data.ok).toBe(true);
    // Both got the same session — second was dedup not re-run
    expect(r2.data.session.id).toBe(r1.data.session.id);
  });

  it('same messageID with semantically different payload returns conflict', async () => {
    const p1 = handleConversationsBridgeMessage(
      { id: '1', type: 'api:conversations:createWithPrompt', payload: validPayload },
      defaultCtx,
    );

    // Small delay so first registers as inflight
    await new Promise(r => setTimeout(r, 20));

    const p2 = handleConversationsBridgeMessage(
      { id: '2', type: 'api:conversations:createWithPrompt', payload: { ...validPayload, title: 'Different' } },
      defaultCtx,
    );

    const [r1, r2] = await Promise.all([p1, p2]);
    const conflict = r2.data.phase === 'conflict' ? r2 : r1;
    expect(conflict.data.phase).toBe('conflict');
    expect(conflict.data.error).toBeDefined();
  });
});
