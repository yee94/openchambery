import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadRuntime = () => import('./bridge-session-turn-changes-runtime.ts');

describe('bridge session turn-changes runtime', () => {
  let originalFetch;
  let responseImpl;
  const defaultCtx = {
    manager: {
      getApiUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
    },
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    responseImpl = async () => new Response('{}', { status: 200 });
    globalThis.fetch = vi.fn(async (...args) => responseImpl(...args));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null for unrelated bridge types', async () => {
    const { handleSessionTurnChangesBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnChangesBridgeMessage(
      { id: 'req_1', type: 'api:other', payload: {} },
      defaultCtx,
    );
    expect(result).toBeNull();
  });

  it('L2 fetches legacy message and returns projected files', async () => {
    responseImpl = async () => new Response(JSON.stringify({
      info: {
        id: 'msg_1',
        summary: {
          diffs: [{
            file: 'src/a.ts',
            status: 'modified',
            additions: 2,
            deletions: 1,
            patch: '@@ secret @@',
          }],
        },
      },
      parts: [{ type: 'text', text: 'body' }],
    }), { status: 200 });

    const { handleSessionTurnChangesBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnChangesBridgeMessage(
      {
        id: 'req_l2',
        type: 'api:session-turn-changes',
        payload: { sessionID: 'ses_1', messageID: 'msg_1', directory: '/repo' },
      },
      defaultCtx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      files: [{ file: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }],
    });
    expect(JSON.stringify(result.data)).not.toContain('secret');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/session/ses_1/message/msg_1'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('L3 fetches session.diff and returns exact file', async () => {
    responseImpl = async () => new Response(JSON.stringify([
      { file: 'src/a.ts', patch: '@@ a @@' },
      { file: 'src/b.ts', patch: '@@ b @@' },
    ]), { status: 200 });

    const { handleSessionTurnChangesBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnChangesBridgeMessage(
      {
        id: 'req_l3',
        type: 'api:session-turn-changes',
        payload: {
          sessionID: 'ses_1',
          messageID: 'msg_1',
          file: 'src/b.ts',
        },
      },
      defaultCtx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      diff: { file: 'src/b.ts', patch: '@@ b @@' },
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/session\/ses_1\/diff\?.*messageID=msg_1/),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects missing messageID', async () => {
    const { handleSessionTurnChangesBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnChangesBridgeMessage(
      {
        id: 'req_bad',
        type: 'api:session-turn-changes',
        payload: { sessionID: 'ses_1' },
      },
      defaultCtx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('messageID is required');
  });

  it('rejects DEL (0x7f) in file with invalid_file', async () => {
    const { handleSessionTurnChangesBridgeMessage } = await loadRuntime();
    const result = await handleSessionTurnChangesBridgeMessage(
      {
        id: 'req_del',
        type: 'api:session-turn-changes',
        payload: {
          sessionID: 'ses_1',
          messageID: 'msg_1',
          file: `evil${String.fromCharCode(0x7f)}.ts`,
        },
      },
      defaultCtx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('file is invalid');
    expect(result.data).toEqual({ code: 'invalid_file', status: 400 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
