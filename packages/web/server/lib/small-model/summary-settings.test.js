import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';

const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-summary-settings-'));
const originalDataDir = process.env.OPENCHAMBER_DATA_DIR;
process.env.OPENCHAMBER_DATA_DIR = tempRoot;

vi.mock('../opencode/shared.js', () => ({
  readConfigLayers: vi.fn(() => ({ mergedConfig: {} })),
}));

vi.mock('./custom-api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  generateCustomSummaryText: vi.fn(async () => 'Generated summary'),
}));

const { createSmallModelService } = await import('./index.js');
const { generateCustomSummaryText } = await import('./custom-api.js');

const writeSettings = (settings) => fsPromises.writeFile(
  path.join(tempRoot, 'settings.json'),
  JSON.stringify(settings),
  'utf8',
);

const completionOf = (text) => ({
  completion: { choices: [{ message: { role: 'assistant', content: text } }] },
});

const createService = ({ catalog = {}, defaultModel = null } = {}) => {
  const createChatCompletion = vi.fn(async () => completionOf('Gateway summary'));
  const modelDefault = vi.fn(async () => ({ data: defaultModel }));
  const service = createSmallModelService({
    buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
    getOpenCodeAuthHeaders: () => ({}),
    getModelCatalog: async () => catalog,
    openCodeClientFactory: () => ({ model: { default: modelDefault } }),
    createChatCompletion,
  });
  return { ...service, createChatCompletion, modelDefault };
};

describe('summary AI settings', () => {
  beforeEach(async () => {
    vi.mocked(generateCustomSummaryText).mockClear();
    await writeSettings({
      summaryModelMode: 'custom',
      summaryCustomBaseURL: 'https://summary.example.test/v1',
      summaryModelID: 'summary-model',
      summaryCustomAPIToken: 'summary-token',
      summaryCommitPrompt: 'Return commit JSON.',
    });
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
    const { generateSmallModelText, createChatCompletion } = createService();
    const result = await generateSmallModelText({
      purpose: 'commit',
      prompt: 'Diff content',
      system: 'Fallback system prompt',
      maxOutputTokens: 64,
    });

    expect(createChatCompletion).not.toHaveBeenCalled();
    expect(generateCustomSummaryText).toHaveBeenCalledWith({
      baseURL: 'https://summary.example.test/v1',
      apiToken: 'summary-token',
      modelID: 'summary-model',
      prompt: 'Diff content',
      system: 'Return commit JSON.',
      maxOutputTokens: 64,
    });
    expect(result).toEqual({
      text: 'Generated summary',
      providerID: 'custom',
      modelID: 'summary-model',
      source: 'summary-custom',
    });
    expect(JSON.stringify(result)).not.toContain('summary-token');
  });

  it('routes a saved provider model through the Assistant LLM gateway', async () => {
    await writeSettings({
      summaryModelMode: 'provider',
      summaryProviderID: 'openai',
      summaryModelID: 'gpt-5.4-mini',
      summaryCommitPrompt: 'Return commit JSON.',
    });

    const { generateSmallModelText, createChatCompletion, modelDefault } = createService();
    const result = await generateSmallModelText({
      purpose: 'commit',
      prompt: 'Diff content',
      system: 'Fallback system prompt',
    });

    expect(modelDefault).not.toHaveBeenCalled();
    expect(generateCustomSummaryText).not.toHaveBeenCalled();
    expect(createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        providerID: 'openai',
        modelID: 'gpt-5.4-mini',
        messages: [
          { role: 'system', content: 'Return commit JSON.' },
          { role: 'user', content: 'Diff content' },
        ],
      },
    }));
    expect(result).toEqual({
      text: 'Gateway summary',
      providerID: 'openai',
      modelID: 'gpt-5.4-mini',
      source: 'summary-provider',
    });
  });

  it('follows the OpenCode default model when no summary model is saved', async () => {
    await writeSettings({});
    const { generateSmallModelText, createChatCompletion } = createService({
      defaultModel: { id: 'claude-sonnet-4-5', modelID: 'internal-pack', providerID: 'anthropic' },
    });

    const result = await generateSmallModelText({
      purpose: 'session-title',
      prompt: 'Conversation content',
      system: 'Title system prompt',
      preferredProviderID: 'openai',
      restrictToPreferredProvider: true,
    });

    expect(createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }),
    }));
    expect(result).toMatchObject({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-5',
      source: 'summary-default',
    });
  });

  it('fails explicitly when OpenCode has no default model', async () => {
    await writeSettings({ summaryModelMode: 'provider' });
    const { generateSmallModelText, createChatCompletion } = createService();

    await expect(generateSmallModelText({
      purpose: 'commit',
      prompt: 'Diff content',
    })).rejects.toMatchObject({
      message: 'No OpenCode default model is configured',
      statusCode: 404,
    });
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it('surfaces gateway failures instead of falling back to another model', async () => {
    await writeSettings({
      summaryModelMode: 'provider',
      summaryProviderID: 'openai',
      summaryModelID: 'missing-model',
    });
    const { generateSmallModelText, createChatCompletion } = createService();
    createChatCompletion.mockRejectedValueOnce(Object.assign(
      new Error('No connected OpenCode provider for openai/missing-model'),
      { statusCode: 400, code: 'no_provider' },
    ));

    await expect(generateSmallModelText({
      purpose: 'commit',
      prompt: 'Diff content',
    })).rejects.toMatchObject({ statusCode: 400, code: 'no_provider' });
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(generateCustomSummaryText).not.toHaveBeenCalled();
  });

  it('requires a custom base URL, model ID, and token before enabling custom mode', async () => {
    await writeSettings({
      summaryModelMode: 'custom',
      summaryCustomBaseURL: 'https://summary.example.test/v1',
      summaryModelID: 'summary-model',
    });

    const { generateSmallModelText } = createService();
    await expect(generateSmallModelText({
      purpose: 'commit',
      prompt: 'Diff content',
    })).rejects.toMatchObject({
      message: 'Custom summary API requires a Base URL, model ID, and API token',
      statusCode: 400,
    });
  });

  it('prefers summaryCustomModelID over the shared summaryModelID for custom calls', async () => {
    await writeSettings({
      summaryModelMode: 'custom',
      summaryCustomBaseURL: 'https://summary.example.test/v1',
      summaryModelID: 'provider-model',
      summaryCustomModelID: 'custom-model',
      summaryCustomAPIToken: 'summary-token',
    });

    const { generateSmallModelText } = createService();
    await generateSmallModelText({
      purpose: 'commit',
      prompt: 'Diff content',
    });

    expect(generateCustomSummaryText).toHaveBeenCalledWith(expect.objectContaining({
      modelID: 'custom-model',
    }));
  });

  it('sends explicit non-summary models through the same gateway', async () => {
    await writeSettings({ summaryModelMode: 'provider', summaryProviderID: 'openai', summaryModelID: 'gpt-5.4' });

    const { generateSmallModelText, createChatCompletion } = createService({
      catalog: { codebuddy: { id: 'codebuddy', name: 'CodeBuddy', models: { 'codebuddy-flash': { id: 'codebuddy-flash' } } } },
    });
    const result = await generateSmallModelText({
      purpose: 'goal',
      prompt: 'Goal content',
      model: 'codebuddy/codebuddy-flash',
    });

    expect(createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ providerID: 'codebuddy', modelID: 'codebuddy-flash' }),
    }));
    expect(result).toMatchObject({ providerID: 'codebuddy', modelID: 'codebuddy-flash', source: 'request' });
  });

  it('resolves non-summary purposes from the connected catalog on the session provider', async () => {
    await writeSettings({});
    const { generateSmallModelText, createChatCompletion } = createService({
      catalog: {
        openai: { id: 'openai', models: { 'gpt-5.5': { id: 'gpt-5.5' } } },
        google: { id: 'google', models: { 'gemini-2.5-flash': { id: 'gemini-2.5-flash', family: 'gemini-flash' } } },
      },
    });
    const result = await generateSmallModelText({
      purpose: 'goal',
      prompt: 'Goal content',
      preferredProviderID: 'openai',
      preferredModelID: 'gpt-5.5',
      restrictToPreferredProvider: true,
    });

    expect(createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ providerID: 'openai', modelID: 'gpt-5.5' }),
    }));
    expect(result).toMatchObject({ source: 'session-model' });
  });

  it('fails explicitly when no connected provider has a model', async () => {
    await writeSettings({});
    const { generateSmallModelText, createChatCompletion } = createService({ catalog: {} });

    await expect(generateSmallModelText({
      purpose: 'goal',
      prompt: 'Goal content',
    })).rejects.toMatchObject({ statusCode: 404 });
    expect(createChatCompletion).not.toHaveBeenCalled();
  });
});
