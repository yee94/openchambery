import { beforeEach, describe, expect, it, mock } from 'bun:test';

const gitService = {
  getGitRangeFiles: mock(),
  getGitRangeDiff: mock(),
};

const sdkClient = {
  model: {
    list: mock(),
  },
  message: {
    list: mock(),
  },
  session: {
    create: mock(),
    prompt: mock(),
    remove: mock(),
  },
};

const make = mock(() => sdkClient);
const rawFetch = mock(async () => {
  throw new Error('raw fetch should not be used');
});

mock.module('./gitService', () => gitService);
mock.module('@opencode-ai/client', () => ({ OpenCode: { make } }));

const { handleSpecialGitBridgeMessage } = await import('./bridge-git-special-runtime');

describe('bridge git special runtime', () => {
  beforeEach(() => {
    gitService.getGitRangeFiles.mockReset();
    gitService.getGitRangeDiff.mockReset();
    sdkClient.model.list.mockReset();
    sdkClient.session.create.mockReset();
    sdkClient.session.prompt.mockReset();
    sdkClient.message.list.mockReset();
    sdkClient.session.remove.mockReset();
    make.mockReset();
    rawFetch.mockClear();

    globalThis.fetch = rawFetch;
    make.mockImplementation(() => sdkClient);
    gitService.getGitRangeFiles.mockImplementation(async () => ['src/a.ts']);
    gitService.getGitRangeDiff.mockImplementation(async () => ({ diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line' }));
    sdkClient.model.list.mockImplementation(async () => ({
      data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-5' }],
    }));
    sdkClient.session.create.mockImplementation(async () => ({ id: 'ses_1' }));
    sdkClient.session.prompt.mockImplementation(async () => ({
      id: 'inbox_1',
      sessionID: 'ses_1',
      timeCreated: Date.now(),
      type: 'user',
      payload: { text: 'draft' },
      delivery: 'steer',
    }));
    sdkClient.message.list.mockImplementation(async () => ({
      data: [{
        type: 'assistant',
        finish: 'stop',
        content: [{ type: 'text', text: '{"title":"PR title","body":"PR body"}' }],
      }],
      cursor: {},
    }));
    sdkClient.session.remove.mockImplementation(async () => undefined);
  });

  it('generates PR descriptions through the OpenCode SDK session flow', async () => {
    const response = await handleSpecialGitBridgeMessage({
      id: '1',
      type: 'api:git/pr-description',
      payload: {
        directory: '/repo',
        base: 'main',
        head: 'feature',
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response).toEqual({
      id: '1',
      type: 'api:git/pr-description',
      success: true,
      data: { title: 'PR title', body: 'PR body' },
    });
    expect(rawFetch).not.toHaveBeenCalled();
    expect(make).toHaveBeenCalledWith({
      baseUrl: 'http://opencode.test',
      headers: { Authorization: 'Bearer test' },
      fetch: expect.any(Function),
    });
    expect(sdkClient.model.list).toHaveBeenCalled();
    expect(sdkClient.session.create).toHaveBeenCalledWith({
      title: 'Git Generation',
      location: { directory: '/repo' },
      model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sdkClient.session.prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_1',
      text: expect.any(String),
      delivery: 'steer',
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sdkClient.message.list).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      limit: 10,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sdkClient.session.remove).toHaveBeenCalledWith({ sessionID: 'ses_1' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
