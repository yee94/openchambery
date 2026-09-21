import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsPromises from 'fs/promises';
import path from 'path';

vi.mock('@opencode/client', () => ({
  OpenCode: { make: vi.fn() },
}));

const { OpenCode } = await import('@opencode/client');
const {
  generateViaOpenCodeSession,
  stop,
  SMALL_MODEL_AGENT_NAME,
  _test,
} = await import('./opencode-session.js');

const buildOpenCodeUrl = () => 'http://127.0.0.1:4096/';
const getOpenCodeAuthHeaders = () => ({ authorization: 'Bearer test' });

const createMockClient = ({
  text = vi.fn(async () => ({ text: 'Hello from generate' })),
} = {}) => {
  const client = {
    generate: { text },
    session: {
      create: vi.fn(async () => {
        throw new Error('session.create must not be used for small-model text');
      }),
      prompt: vi.fn(async () => {
        throw new Error('session.prompt must not be used for small-model text');
      }),
    },
  };
  OpenCode.make.mockReturnValue(client);
  return { client, text };
};

describe('generateViaOpenCodeSession', () => {
  beforeEach(() => {
    OpenCode.make.mockReset();
    _test.resetTempDirectory();
  });

  afterEach(async () => {
    await stop();
    _test.resetTempDirectory();
  });

  it('uses generate.text with model id/providerID and never opens a coding session', async () => {
    const { text } = createMockClient();

    const result = await generateViaOpenCodeSession({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      providerID: 'codebuddy',
      modelID: 'codebuddy-flash',
      prompt: 'Summarize this',
      system: 'Be brief',
      purpose: 'session-title',
    });

    expect(result).toBe('Hello from generate');
    expect(OpenCode.make).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'http://127.0.0.1:4096',
      headers: { authorization: 'Bearer test' },
    }));

    expect(text).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('Be brief'),
      model: { id: 'codebuddy-flash', providerID: 'codebuddy' },
    }), expect.any(Object));
    expect(text.mock.calls[0][0].prompt).toContain('Summarize this');

    // Deny-all agent workspace is still prepared for isolation invariants.
    const tempDir = _test.getTempDirectory();
    expect(tempDir).toMatch(/openchamber-smallmodel-/);
    expect(await fsPromises.readFile(
      path.join(tempDir, '.opencode', 'agent', `${SMALL_MODEL_AGENT_NAME}.md`),
      'utf8',
    )).toContain('effect: deny');
  });

  it('passes optional directory as generate.text location', async () => {
    const { text } = createMockClient();
    await generateViaOpenCodeSession({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      providerID: 'codebuddy',
      modelID: 'codebuddy-flash',
      prompt: 'ok',
      directory: '/repo/project',
    });
    expect(text).toHaveBeenCalledWith(expect.objectContaining({
      location: { directory: '/repo/project' },
    }), expect.any(Object));
  });

  it('throws on timeout', async () => {
    createMockClient({
      text: vi.fn(async (_input, opts) => new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener?.('abort', () => {
          reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error('aborted'));
        });
      })),
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
  });

  it('throws when generate.text returns empty text', async () => {
    createMockClient({
      text: vi.fn(async () => ({ text: '   ' })),
    });

    await expect(generateViaOpenCodeSession({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      providerID: 'codebuddy',
      modelID: 'codebuddy-flash',
      prompt: 'empty',
    })).rejects.toThrow(/no assistant text/);
  });

  it('surfaces generate.text failures without empty success', async () => {
    createMockClient({
      text: vi.fn(async () => {
        throw new Error('provider offline');
      }),
    });

    await expect(generateViaOpenCodeSession({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      providerID: 'codebuddy',
      modelID: 'codebuddy-flash',
      prompt: 'fail',
    })).rejects.toThrow(/provider offline/);
  });
});
