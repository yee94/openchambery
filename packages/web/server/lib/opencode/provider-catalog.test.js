import { describe, expect, it } from 'vitest';
import { projectProviderCatalog } from './provider-catalog.js';

const safeCatalog = () => ({
  providers: [{
    id: 'openai',
    name: 'OpenAI',
    key: 'provider-secret-sentinel',
    options: { token: 'provider-options-sentinel' },
    env: ['provider-env-sentinel'],
    source: 'provider-source-sentinel',
    models: {
      'gpt-5': {
        id: 'gpt-5',
        name: 'GPT 5',
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: true },
          output: { text: true, audio: true, image: false, video: false, pdf: false },
          hidden: 'capability-hidden-sentinel',
        },
        cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2, secret: 'cost-sentinel' }, unknown: 'cost-hidden-sentinel' },
        limit: { context: 128000, output: 16000, hidden: 'limit-sentinel' },
        release_date: '2026-07-22',
        variants: { low: { api: 'variant-api-sentinel' }, high: { headers: 'variant-headers-sentinel' } },
        headers: { Authorization: 'model-headers-sentinel' },
        options: { apiKey: 'model-options-sentinel' },
        api: 'https://model-api-sentinel.example',
        providerID: 'provider-id-sentinel',
        family: 'model-family-sentinel',
        status: 'model-status-sentinel',
        interleaved: 'model-interleaved-sentinel',
        nested: { secret: 'model-nested-sentinel' },
      },
    },
  }],
  default: { general: 'openai/gpt-5' },
});

describe('projectProviderCatalog', () => {
  it('projects only the safe allowlist and strips sentinel values from JSON', () => {
    const result = projectProviderCatalog(safeCatalog());
    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        providers: [{
          id: 'openai',
          name: 'OpenAI',
          models: {
            'gpt-5': {
              id: 'gpt-5',
              name: 'GPT 5',
              capabilities: {
                temperature: true,
                reasoning: false,
                attachment: true,
                toolcall: true,
                input: { text: true, audio: false, image: true, video: false, pdf: true },
                output: { text: true, audio: true, image: false, video: false, pdf: false },
              },
              cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
              limit: { context: 128000, output: 16000 },
              release_date: '2026-07-22',
              variants: { low: {}, high: {} },
            },
          },
        }],
        default: { general: 'openai/gpt-5' },
        partial: false,
      },
    });
    expect(JSON.stringify(result.value)).not.toContain('sentinel');
  });

  it('isolates invalid providers and models while retaining complete entries', () => {
    const catalog = safeCatalog();
    catalog.providers.push({ id: 'broken', name: 'Broken', models: { invalid: { id: 42, name: 'Invalid' } } });
    catalog.providers.push({ id: 42, name: 'Invalid provider', models: {} });
    const result = projectProviderCatalog(catalog);
    expect(result.ok).toBe(true);
    expect(result.value.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'openai' }),
      { id: 'broken', name: 'Broken', models: {} },
    ]));
    expect(result.value.partial).toBe(true);
  });

  it('fails closed for malformed catalog roots', () => {
    expect(projectProviderCatalog({ providers: [], default: [] })).toEqual({ ok: false });
    expect(projectProviderCatalog({ providers: {} , default: {} })).toEqual({ ok: false });
  });

  it('isolates dangerous identifiers and unknown modalities without prototype pollution', () => {
    const catalog = JSON.parse(`{
      "providers": [
        { "id": "__proto__", "name": "Unsafe provider", "models": {} },
        { "id": "safe", "name": "Safe", "models": {
          "constructor": { "id": "key-danger", "name": "Key danger" },
          "unsafe-id": { "id": "prototype", "name": "ID danger" },
          "safe-model": {
            "id": "safe-model", "name": "Safe model",
            "variants": { "__proto__": {} },
            "capabilities": { "input": { "__proto__": true, "text": true } }
          }
        }}
      ],
      "default": { "constructor": "safe/model", "safe": "__proto__" }
    }`);

    const result = projectProviderCatalog(catalog);
    expect(result.value.providers).toEqual([{
      id: 'safe',
      name: 'Safe',
      models: {
        'safe-model': {
          id: 'safe-model',
          name: 'Safe model',
          capabilities: { input: { text: true } },
        },
      },
    }]);
    expect(result.value.default).toEqual({});
    expect(result.value.partial).toBe(true);
    expect({}.polluted).toBeUndefined();
  });

  it('enforces numeric, release date, collection, and duplicate identifier limits', () => {
    const catalog = safeCatalog();
    const model = catalog.providers[0].models['gpt-5'];
    model.cost.input = 1_000_000_000;
    model.cost.output = -1_000_000_000;
    model.cost.cache.read = 1_000_000_001;
    model.limit.context = -1_000_000_001;
    model.release_date = `2026-07-22\u0000`;
    catalog.providers.push({ id: 'openai', name: 'Duplicate', models: {} });
    catalog.providers[0].models.alias = { id: 'gpt-5', name: 'Duplicate model' };
    catalog.default = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`default-${index}`, 'openai/gpt-5']));

    const result = projectProviderCatalog(catalog);
    expect(result.value.providers).toHaveLength(1);
    expect(result.value.providers[0].models).toEqual({
      'gpt-5': expect.objectContaining({
        cost: { input: 1_000_000_000, output: -1_000_000_000, cache: { write: 0.2 } },
        limit: { output: 16000 },
      }),
    });
    expect(result.value.providers[0].models['gpt-5']).not.toHaveProperty('release_date');
    expect(Object.keys(result.value.default)).toHaveLength(100);
    expect(result.value.partial).toBe(true);
  });

  it('bounds provider, model, and variant dictionaries while retaining their valid prefixes', () => {
    const model = (id) => ({ id, name: id });
    const providers = Array.from({ length: 201 }, (_, index) => ({
      id: `provider-${index}`,
      name: `Provider ${index}`,
      models: {},
    }));
    providers[0].models = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`model-${index}`, model(`model-${index}`)]));
    providers[1].models = {
      bounded: {
        ...model('bounded'),
        variants: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`variant-${index}`, {}])),
      },
    };

    const result = projectProviderCatalog({ providers, default: {} });
    expect(result.value.providers).toHaveLength(200);
    expect(Object.keys(result.value.providers[0].models)).toHaveLength(500);
    expect(Object.keys(result.value.providers[1].models.bounded.variants)).toHaveLength(100);
    expect(result.value.partial).toBe(true);
  });
});
