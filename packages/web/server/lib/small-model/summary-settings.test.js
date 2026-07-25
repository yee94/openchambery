import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';

const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-summary-settings-'));
const originalDataDir = process.env.OPENCHAMBER_DATA_DIR;
process.env.OPENCHAMBER_DATA_DIR = tempRoot;

vi.mock('../opencode/auth.js', () => ({
  readAuthFile: vi.fn(() => ({})),
}));

vi.mock('../opencode/shared.js', () => ({
  readConfigLayers: vi.fn(() => ({ mergedConfig: {} })),
}));

vi.mock('./call.js', () => ({
  callSmallModel: vi.fn(async () => 'Generated summary'),
}));

const { createSmallModelService } = await import('./index.js');
const { callSmallModel } = await import('./call.js');
const { readAuthFile } = await import('../opencode/auth.js');

const createService = (catalog = {}) => createSmallModelService({
  buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
  getOpenCodeAuthHeaders: () => ({}),
  getModelCatalog: async () => catalog,
});

describe('summary AI settings', () => {
  beforeEach(async () => {
    vi.mocked(callSmallModel).mockClear();
    vi.mocked(readAuthFile).mockReturnValue({});
    await fsPromises.writeFile(path.join(tempRoot, 'settings.json'), JSON.stringify({
      summaryModelMode: 'custom',
      summaryCustomBaseURL: 'https://summary.example.test/v1',
      summaryModelID: 'summary-model',
      summaryCustomAPIToken: 'summary-token',
      summaryCommitPrompt: 'Return commit JSON.',
    }), 'utf8');
  });

  afterAll(async () => {
    if (originalDataDir === undefined) {
      delete process.env.OPENCHAMBER_DATA_DIR;
    } else {
      process.env.OPENCHAMBER_DATA_DIR = originalDataDir;
    }
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  });

  it('uses a persisted custom API and prompt for commit summaries', async () => {
    const { generateSmallModelText } = createService();
    const result = await generateSmallModelText({
      purpose: 'commit',
      prompt: 'Diff content',
      system: 'Fallback system prompt',
      maxOutputTokens: 64,
    });

    expect(callSmallModel).toHaveBeenCalledWith(expect.objectContaining({
      providerID: 'custom',
      modelID: 'summary-model',
      system: 'Return commit JSON.',
      custom: {
        baseURL: 'https://summary.example.test/v1',
        apiToken: 'summary-token',
        modelID: 'summary-model',
      },
    }));
    expect(result).toEqual({
      text: 'Generated summary',
      providerID: 'custom',
      modelID: 'summary-model',
      source: 'summary-custom',
    });
    expect(JSON.stringify(result)).not.toContain('summary-token');
  });

  it('uses the displayed default Summary AI model across session providers', async () => {
    vi.mocked(readAuthFile).mockReturnValue({
      openai: {
        type: 'oauth',
        access: 'openai-access-token',
      },
    });
    await fsPromises.writeFile(path.join(tempRoot, 'settings.json'), JSON.stringify({}), 'utf8');

    const { generateSmallModelText } = createService();
    const result = await generateSmallModelText({
      purpose: 'session-title',
      prompt: 'Conversation content',
      preferredProviderID: 'anthropic',
      preferredModelID: 'claude-sonnet-4-5',
      restrictToPreferredProvider: true,
    });

    expect(callSmallModel).toHaveBeenCalledWith(expect.objectContaining({
      providerID: 'openai',
      modelID: 'gpt-5.4-mini',
    }));
    expect(result).toEqual({
      text: 'Generated summary',
      providerID: 'openai',
      modelID: 'gpt-5.4-mini',
      source: 'summary-default',
    });
  });

  it('excludes dedicated providers with unsupported auth types from callable lists', async () => {
    vi.mocked(readAuthFile).mockReturnValue({
      openai: { type: 'wellknown', token: 'openai-wellknown-token' },
      anthropic: { type: 'oauth', access: 'anthropic-access', refresh: 'anthropic-refresh', expires: 0 },
      google: { type: 'oauth', access: 'google-access', refresh: 'google-refresh', expires: 0 },
      mistral: { type: 'api', key: 'mistral-key' },
    });

    const catalog = {
      mistral: {
        id: 'mistral',
        name: 'Mistral',
        models: {
          'mistral-small': {
            id: 'mistral-small',
            api: { url: 'https://api.mistral.ai/v1' },
          },
        },
      },
      anthropic: {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-haiku-4-5': { id: 'claude-haiku-4-5', family: 'claude-haiku' },
        },
      },
    };

    const { listCallableProviders, listCallableModels } = createService(catalog);
    const providers = await listCallableProviders();
    const models = await listCallableModels();

    expect(providers).toEqual(['mistral']);
    expect(models).toEqual({ mistral: ['mistral-small'] });
    expect(providers).not.toContain('openai');
    expect(providers).not.toContain('anthropic');
    expect(providers).not.toContain('google');
  });

  it('lists OpenAI api/oauth, Anthropic/Google api keys, and Copilot aliases as callable', async () => {
    vi.mocked(readAuthFile).mockReturnValue({
      openai: { type: 'api', key: 'sk-openai' },
      anthropic: { type: 'api', key: 'sk-anthropic' },
      google: { type: 'api', key: 'google-key' },
      copilot: { type: 'oauth', access: 'copilot-token', refresh: 'copilot-token', expires: 0 },
    });

    const catalog = {
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: { 'gpt-4.1-nano': { id: 'gpt-4.1-nano', family: 'gpt-nano' } },
      },
      anthropic: {
        id: 'anthropic',
        name: 'Anthropic',
        models: { 'claude-haiku-4-5': { id: 'claude-haiku-4-5', family: 'claude-haiku' } },
      },
      google: {
        id: 'google',
        name: 'Google',
        models: { 'gemini-2.5-flash': { id: 'gemini-2.5-flash', family: 'gemini-flash' } },
      },
    };

    const { listCallableProviders, listCallableModels } = createService(catalog);
    const providers = await listCallableProviders();
    const models = await listCallableModels();

    expect(providers.sort()).toEqual(['anthropic', 'github-copilot', 'google', 'openai']);
    expect(models.openai).toEqual(['gpt-4.1-nano']);
    expect(models.anthropic).toEqual(['claude-haiku-4-5']);
    expect(models.google).toEqual(['gemini-2.5-flash']);
    expect(models['github-copilot']).toEqual(['gpt-5.4-nano']);
  });

  it('keeps OpenAI oauth callable with the codex small model only', async () => {
    vi.mocked(readAuthFile).mockReturnValue({
      openai: { type: 'oauth', access: 'openai-access', refresh: 'openai-refresh', expires: 0 },
    });

    const { listCallableProviders, listCallableModels } = createService({});
    expect(await listCallableProviders()).toEqual(['openai']);
    expect(await listCallableModels()).toEqual({ openai: ['gpt-5.4-mini'] });
  });

  it('does not list other providers without a catalog model api.url', async () => {
    vi.mocked(readAuthFile).mockReturnValue({
      mistral: { type: 'api', key: 'mistral-key' },
      deepseek: { type: 'api', key: 'deepseek-key' },
    });

    const catalog = {
      mistral: {
        id: 'mistral',
        name: 'Mistral',
        models: {
          'mistral-small': { id: 'mistral-small' },
        },
      },
      deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        models: {
          'deepseek-chat': {
            id: 'deepseek-chat',
            api: { url: 'https://api.deepseek.com/v1' },
          },
        },
      },
    };

    const { listCallableProviders, listCallableModels } = createService(catalog);
    expect(await listCallableProviders()).toEqual(['deepseek']);
    expect(await listCallableModels()).toEqual({ deepseek: ['deepseek-chat'] });
  });
});
