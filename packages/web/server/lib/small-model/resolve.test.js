import { describe, it, expect } from 'vitest';
import {
  resolveSmallModel,
  parseModelRef,
  rankSmallModelCandidates,
  compareSmallModelCandidates,
} from './resolve.js';

const catalog = {
  google: {
    id: 'google',
    models: {
      'gemini-2.5-flash': {
        id: 'gemini-2.5-flash',
        family: 'gemini-flash',
        release_date: '2025-06-01',
        cost: { input: 0.15, output: 0.6 },
      },
      'gemini-2.0-flash': {
        id: 'gemini-2.0-flash',
        family: 'gemini-flash',
        release_date: '2024-12-01',
        cost: { input: 0.1, output: 0.4 },
      },
      'gemini-2.5-pro': { id: 'gemini-2.5-pro', family: 'gemini-pro', release_date: '2025-06-01' },
    },
  },
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        family: 'claude-haiku',
        release_date: '2025-10-01',
        cost: { input: 1, output: 5 },
      },
      'claude-sonnet-4-5': { id: 'claude-sonnet-4-5', family: 'claude-sonnet', release_date: '2025-09-01' },
    },
  },
};

describe('parseModelRef', () => {
  it('splits provider/model on the first slash', () => {
    expect(parseModelRef('anthropic/claude-haiku-4-5')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
    });
  });

  it('keeps slashes inside the model id', () => {
    expect(parseModelRef('openrouter/google/gemini-2.5-flash')).toEqual({
      providerID: 'openrouter',
      modelID: 'google/gemini-2.5-flash',
    });
  });

  it('rejects values without a provider or model part', () => {
    expect(parseModelRef('anthropic/')).toBeNull();
    expect(parseModelRef('/model')).toBeNull();
    expect(parseModelRef('plain')).toBeNull();
    expect(parseModelRef(undefined)).toBeNull();
  });
});

describe('resolveSmallModel', () => {
  it('gives the OpenChamber settings override top priority', () => {
    const result = resolveSmallModel({
      catalog,
      settingsSmallModel: 'anthropic/claude-haiku-4-5',
      configSmallModel: 'openai/gpt-4o-mini',
      preferredProviderID: 'anthropic',
    });
    expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku-4-5', source: 'settings' });
  });

  it('prefers the configured small_model', () => {
    const result = resolveSmallModel({ catalog, configSmallModel: 'openai/gpt-4o-mini' });
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o-mini', source: 'config' });
  });

  it('scans connected providers by family priority, cheapest then newest within family', () => {
    const result = resolveSmallModel({ catalog, configSmallModel: null });
    expect(result).toEqual({ providerID: 'google', modelID: 'gemini-2.0-flash', source: 'family-scan' });
  });

  it('returns null when no provider is connected', () => {
    expect(resolveSmallModel({ catalog: {}, configSmallModel: null })).toBeNull();
    expect(resolveSmallModel({ catalog: null, configSmallModel: null })).toBeNull();
  });

  it('prefers the session provider over other connected providers', () => {
    const result = resolveSmallModel({ catalog, configSmallModel: null, preferredProviderID: 'anthropic' });
    expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku-4-5', source: 'family-scan' });
  });

  it('ignores a preferred provider that is not in the connected catalog', () => {
    const result = resolveSmallModel({
      catalog,
      configSmallModel: null,
      preferredProviderID: 'mistral',
      preferredModelID: 'mistral-large-latest',
    });
    expect(result).toEqual({ providerID: 'google', modelID: 'gemini-2.0-flash', source: 'family-scan' });
  });

  it('stays on the preferred provider via keyword scan instead of switching providers', () => {
    const result = resolveSmallModel({
      catalog: {
        ...catalog,
        'opencode-go': {
          id: 'opencode-go',
          models: {
            'deepseek-v4-flash': { id: 'deepseek-v4-flash', family: 'deepseek-flash', release_date: '2026-01-01' },
          },
        },
      },
      configSmallModel: null,
      preferredProviderID: 'opencode-go',
      preferredModelID: 'deepseek-v4-flash',
    });
    expect(result).toEqual({ providerID: 'opencode-go', modelID: 'deepseek-v4-flash', source: 'keyword-scan' });
  });

  it('falls back to the session model when its connected provider has no small model', () => {
    const result = resolveSmallModel({
      catalog: {
        ...catalog,
        openai: { id: 'openai', models: { 'gpt-5.5': { id: 'gpt-5.5', release_date: '2026-01-01' } } },
      },
      configSmallModel: null,
      preferredProviderID: 'openai',
      preferredModelID: 'gpt-5.5',
    });
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-5.5', source: 'session-model' });
  });

  it('picks keyword+cheapest catalog models when no family match exists', () => {
    const result = resolveSmallModel({
      catalog: {
        codebuddy: {
          id: 'codebuddy',
          models: {
            'codebuddy-pro': { id: 'codebuddy-pro', release_date: '2026-01-01', cost: { input: 0.01 } },
            'codebuddy-mini': { id: 'codebuddy-mini', release_date: '2025-06-01', cost: { input: 0.5 } },
            'codebuddy-lite': { id: 'codebuddy-lite', release_date: '2025-06-01', cost: { input: 0.05 } },
          },
        },
        deepseek: {
          id: 'deepseek',
          models: {
            'deepseek-chat': { id: 'deepseek-chat', release_date: '2025-01-01', cost: { input: 0.14 } },
          },
        },
      },
      configSmallModel: null,
    });
    expect(result).toEqual({ providerID: 'codebuddy', modelID: 'codebuddy-mini', source: 'keyword-scan' });
  });

  it('ranks missing cost after priced models and prefers newer release_date on ties', () => {
    const ranked = rankSmallModelCandidates({
      'a-mini': { id: 'a-mini', release_date: '2024-01-01', cost: { input: 1 } },
      'b-mini': { id: 'b-mini', release_date: '2025-01-01', cost: { input: 1 } },
      'c-mini': { id: 'c-mini', release_date: '2026-01-01' },
      'd-flash': { id: 'd-flash', release_date: '2023-01-01', cost: { input: 2 } },
    });
    expect(ranked.map((m) => m.id)).toEqual(['d-flash', 'b-mini', 'a-mini', 'c-mini']);
    expect(compareSmallModelCandidates(
      { id: 'x', cost: { input: 1 }, release_date: '2024-01-01' },
      { id: 'y', cost: { input: 2 }, release_date: '2026-01-01' },
    )).toBeLessThan(0);
  });
});
