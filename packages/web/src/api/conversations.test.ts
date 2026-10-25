import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessagePart } from '@yuriai/ui/lib/api/types';

const mockRuntimeFetch = vi.fn();

vi.mock('@yuriai/ui/lib/runtime-fetch', () => ({
  runtimeFetch: mockRuntimeFetch,
}));

const { createWebConversationsAPI } = await import('./conversations');

describe('web conversations API', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  const api = createWebConversationsAPI();

  const validInput = {
    input: { type: 'prompt' as const },
    directory: '/tmp/test',
    messageID: 'msg_01',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
    parts: [{ type: 'text' as const, text: 'Hello' }],
  };

  const sessionFixture = {
    id: 'ses_test123',
    directory: '/tmp/test',
    title: 'Hello',
    time: { created: Date.now(), updated: Date.now() },
  };

  // --- success ---

  it('returns success result with full session on 201', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          session: sessionFixture,
          messageID: 'msg_01',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await api.createWithPrompt(validInput);
    expect(result).toEqual({
      ok: true,
      session: sessionFixture,
      messageID: 'msg_01',
    });
    expect(mockRuntimeFetch).toHaveBeenCalledWith(
      '/api/yuri/conversations',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validInput),
      }),
    );
  });

  it('passes optional title and agent fields', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, session: sessionFixture, messageID: 'msg_01' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const inputWithOpts = {
      ...validInput,
      title: 'My Chat',
      agent: 'code-reviewer',
      variant: 'fast',
      parentID: 'parent_xyz',
      metadata: { key: 'value' },
    };
    await api.createWithPrompt(inputWithOpts);

    expect(mockRuntimeFetch).toHaveBeenCalledWith(
      '/api/yuri/conversations',
      expect.objectContaining({
        body: JSON.stringify(inputWithOpts),
      }),
    );
  });

  // --- validate phase (400) ---

  it('returns validate result for 400 with errors array', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          phase: 'validate',
          error: 'Invalid request',
          errors: ['directory must be a non-empty string', 'input must be an object'],
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await api.createWithPrompt(validInput);
    expect(result).toEqual({
      ok: false,
      phase: 'validate',
      error: 'Invalid request',
      errors: ['directory must be a non-empty string', 'input must be an object'],
    });
  });

  // --- create phase (400/502) ---

  it('returns create failure with status on permanent 4xx', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          phase: 'create',
          error: 'Failed to create session',
          status: 403,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await api.createWithPrompt(validInput);
    expect(result).toEqual({
      ok: false,
      phase: 'create',
      error: 'Failed to create session',
      status: 403,
    });
  });

  it('returns create failure on 502', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          phase: 'create',
          error: 'Failed to create session',
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await api.createWithPrompt(validInput);
    expect(result).toEqual({
      ok: false,
      phase: 'create',
      error: 'Failed to create session',
    });
  });

  // --- prompt phase (400/502) ---

  it('returns prompt failure with ambiguous=false for 400', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          phase: 'prompt',
          session: { id: 'ses_partial' },
          messageID: 'msg_01',
          ambiguous: false,
          error: 'Failed to submit prompt',
          status: 400,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await api.createWithPrompt(validInput);
    expect(result).toEqual({
      ok: false,
      phase: 'prompt',
      session: { id: 'ses_partial' },
      messageID: 'msg_01',
      ambiguous: false,
      error: 'Failed to submit prompt',
      status: 400,
    });
  });

  it('returns prompt failure with ambiguous=true for 503', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          phase: 'prompt',
          session: { id: 'ses_503' },
          messageID: 'msg_01',
          ambiguous: true,
          error: 'Failed to submit prompt',
          status: 503,
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await api.createWithPrompt(validInput);
    expect(result).toEqual({
      ok: false,
      phase: 'prompt',
      session: { id: 'ses_503' },
      messageID: 'msg_01',
      ambiguous: true,
      error: 'Failed to submit prompt',
      status: 503,
    });
  });

  // --- internal phase ---

  it('returns internal error on 500', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          phase: 'internal',
          error: 'Internal server error',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await api.createWithPrompt(validInput);
    expect(result).toEqual({
      ok: false,
      phase: 'internal',
      error: 'Internal server error',
    });
  });

  // --- transport / malformed ---

  it('throws stable error on transport failure', async () => {
    mockRuntimeFetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(api.createWithPrompt(validInput)).rejects.toThrow(
      'Conversation request failed',
    );
  });

  it('throws on malformed (non-JSON) response', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    await expect(api.createWithPrompt(validInput)).rejects.toThrow(
      'Unexpected server response: invalid JSON',
    );
  });

  it('throws on JSON that does not match result shape', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(api.createWithPrompt(validInput)).rejects.toThrow(
      'Unexpected server response: result shape mismatch',
    );
  });

  it('throws on create result with non-finite status', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, phase: 'create', error: 'fail', status: NaN }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(api.createWithPrompt(validInput)).rejects.toThrow(
      'Unexpected server response: result shape mismatch',
    );
  });

  // --- abort signal ---

  it('passes AbortSignal through to runtimeFetch', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          session: sessionFixture,
          messageID: 'msg_abort',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const controller = new AbortController();
    await api.createWithPrompt(validInput, controller.signal);

    expect(mockRuntimeFetch).toHaveBeenCalledWith(
      '/api/yuri/conversations',
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  // --- file parts ---

  it('passes file part with all optional fields', async () => {
    mockRuntimeFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, session: sessionFixture, messageID: 'msg_file' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const fileInput = {
      ...validInput,
      parts: [
        { type: 'text' as const, text: 'Check', synthetic: true, id: 'p1' },
        { type: 'file' as const, mime: 'text/typescript', url: 'file:///repo/src/a.ts', filename: 'a.ts', source: { type: 'selection', path: '/a.ts' } as unknown },
        { type: 'agent' as const, name: 'builder', source: { value: '@builder', start: 0, end: 8 } },
      ],
    };
    // parts use SDK-native types; test fixture uses `as` for non-standard source fields
    await api.createWithPrompt({ ...fileInput, parts: fileInput.parts as ConversationMessagePart[] });

    const sent = JSON.parse(mockRuntimeFetch.mock.calls[0][1].body);
    expect(sent.parts).toHaveLength(3);
    expect(sent.parts[1]).toEqual({
      type: 'file', mime: 'text/typescript', url: 'file:///repo/src/a.ts', filename: 'a.ts', source: { type: 'selection', path: '/a.ts' },
    });
  });
});
