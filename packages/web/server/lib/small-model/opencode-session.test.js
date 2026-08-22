import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsPromises from 'fs/promises';
import path from 'path';

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: vi.fn(),
}));

const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
const {
  generateViaOpenCodeSession,
  stop,
  SMALL_MODEL_AGENT_NAME,
  _test,
} = await import('./opencode-session.js');

const buildOpenCodeUrl = () => 'http://127.0.0.1:4096/';
const getOpenCodeAuthHeaders = () => ({ authorization: 'Bearer test' });

const completedAssistant = (text) => ({
  info: {
    role: 'assistant',
    time: { completed: Date.now() },
  },
  parts: [{ type: 'text', text }],
});

const createMockClient = ({
  create = vi.fn(async () => ({ data: { id: 'ses_small_1' } })),
  update = vi.fn(async () => ({ data: { id: 'ses_small_1' } })),
  promptAsync = vi.fn(async () => ({ response: { status: 204 } })),
  status = vi.fn(async () => ({ data: { ses_small_1: { type: 'idle' } } })),
  messages = vi.fn(async () => ({ data: [completedAssistant('Hello from session')] })),
  deleteSession = vi.fn(async () => ({ data: true })),
} = {}) => {
  const client = {
    session: {
      create,
      update,
      promptAsync,
      status,
      messages,
      delete: deleteSession,
    },
  };
  createOpencodeClient.mockReturnValue(client);
  return { client, create, update, promptAsync, status, messages, deleteSession };
};

describe('generateViaOpenCodeSession', () => {
  beforeEach(() => {
    createOpencodeClient.mockReset();
    _test.resetTempDirectory();
  });

  afterEach(async () => {
    await stop();
    _test.resetTempDirectory();
  });

  it('creates a marked archived session, prompts, returns assistant text, and deletes', async () => {
    const { create, update, promptAsync, deleteSession } = createMockClient();

    const text = await generateViaOpenCodeSession({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      providerID: 'codebuddy',
      modelID: 'codebuddy-flash',
      prompt: 'Summarize this',
      system: 'Be brief',
      purpose: 'session-title',
    });

    expect(text).toBe('Hello from session');
    expect(createOpencodeClient).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'http://127.0.0.1:4096',
      headers: { authorization: 'Bearer test' },
    }));

    const tempDir = create.mock.calls[0][0].directory;
    expect(tempDir).toMatch(/openchamber-smallmodel-/);
    expect(await fsPromises.readFile(
      path.join(tempDir, '.opencode', 'agent', `${SMALL_MODEL_AGENT_NAME}.md`),
      'utf8',
    )).toContain('effect: deny');

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      directory: tempDir,
      title: '[small-model] session-title',
      agent: SMALL_MODEL_AGENT_NAME,
      metadata: {
        openchamber: {
          smallModel: { purpose: 'session-title' },
        },
      },
    }), expect.any(Object));

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_small_1',
      directory: tempDir,
      time: { archived: expect.any(Number) },
    }));

    expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_small_1',
      directory: tempDir,
      agent: SMALL_MODEL_AGENT_NAME,
      model: { providerID: 'codebuddy', modelID: 'codebuddy-flash' },
      system: 'Be brief',
      parts: [{ type: 'text', text: 'Summarize this', synthetic: false }],
    }), expect.any(Object));

    expect(deleteSession).toHaveBeenCalledWith({
      sessionID: 'ses_small_1',
      directory: tempDir,
    });
  });

  it('throws on settle timeout and still best-effort deletes the session', async () => {
    const { deleteSession } = createMockClient({
      status: vi.fn(async () => ({ data: { ses_small_1: { type: 'busy' } } })),
      messages: vi.fn(async () => ({ data: [] })),
    });

    await expect(generateViaOpenCodeSession({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      providerID: 'codebuddy',
      modelID: 'codebuddy-flash',
      prompt: 'hang',
      purpose: 'commit',
      settleTimeoutMs: 80,
    })).rejects.toThrow(/timed out/);
    expect(deleteSession).toHaveBeenCalled();
  });

  it('does not swallow a successful result when session.delete fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createMockClient({
      deleteSession: vi.fn(async () => {
        throw new Error('delete boom');
      }),
    });

    const text = await generateViaOpenCodeSession({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      providerID: 'codebuddy',
      modelID: 'codebuddy-flash',
      prompt: 'ok',
      purpose: 'commit',
    });

    expect(text).toBe('Hello from session');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws when the assistant returns empty text', async () => {
    createMockClient({
      messages: vi.fn(async () => ({
        data: [{
          info: { role: 'assistant', time: { completed: Date.now() } },
          parts: [{ type: 'text', text: '   ' }],
        }],
      })),
    });

    await expect(generateViaOpenCodeSession({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      providerID: 'codebuddy',
      modelID: 'codebuddy-flash',
      prompt: 'empty',
    })).rejects.toThrow(/no assistant text/);
  });
});
