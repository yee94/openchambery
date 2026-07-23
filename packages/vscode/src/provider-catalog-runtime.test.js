import { describe, expect, test } from 'bun:test';
import { projectProviderCatalog } from './provider-catalog-runtime.ts';

describe('VS Code provider catalog projection', () => {
  test('serializes only the safe provider catalog contract', () => {
    const result = projectProviderCatalog({
      providers: [{
        id: 'provider',
        name: 'Provider',
        source: 'config',
        env: ['SECRET_SENTINEL'],
        options: { token: 'SECRET_SENTINEL' },
        models: {
          model: {
            id: 'model',
            name: 'Model',
            providerID: 'SECRET_SENTINEL',
            family: 'SECRET_SENTINEL',
            headers: { authorization: 'SECRET_SENTINEL' },
            options: { token: 'SECRET_SENTINEL' },
            api: { key: 'SECRET_SENTINEL' },
            status: 'active',
            interleaved: true,
            capabilities: {
              temperature: true,
              reasoning: false,
              attachment: true,
              toolcall: true,
              input: { text: true, image: true, ignored: true },
              output: { text: true, audio: false },
            },
            cost: { input: 1, output: 2, cache: { read: 3, write: 4, ignored: 5 } },
            limit: { context: 100, output: 20, ignored: 1 },
            release_date: '2026-01-01',
            variants: { fast: { token: 'SECRET_SENTINEL' }, precise: { headers: {} } },
          },
        },
      }],
      default: { provider: 'model' },
      secret: 'SECRET_SENTINEL',
    });

    expect(result).toEqual({
      schemaVersion: 1,
      providers: [{
        id: 'provider',
        name: 'Provider',
        models: {
          model: {
            id: 'model',
            name: 'Model',
            capabilities: { temperature: true, reasoning: false, attachment: true, toolcall: true, input: { text: true, image: true }, output: { text: true, audio: false } },
            cost: { input: 1, output: 2, cache: { read: 3, write: 4 } },
            limit: { context: 100, output: 20 },
            release_date: '2026-01-01',
            variants: { fast: {}, precise: {} },
          },
        },
      }],
      default: { provider: 'model' },
      // Soft allowlist stripping of unknown modalities/extra fields is not partial.
      partial: false,
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL');
  });

  test('isolates malformed entities and rejects malformed top-level payloads', () => {
    const result = projectProviderCatalog({
      providers: [{ id: 'valid', name: 'Valid', models: { good: { id: 'good', name: 'Good' }, bad: { id: 'bad' } } }, { id: 'broken' }],
      default: { valid: 'good', broken: 1 },
    });
    expect(result).toEqual({
      schemaVersion: 1,
      providers: [{ id: 'valid', name: 'Valid', models: { good: { id: 'good', name: 'Good' } } }],
      default: { valid: 'good' },
      partial: true,
    });
    expect(() => projectProviderCatalog({ providers: {} })).toThrow('Malformed OpenCode provider catalog response');
  });

  test('isolates dangerous identifiers, duplicates, invalid defaults, variants, and modalities', () => {
    const models = Object.create(null);
    models.good = { id: 'model', name: 'Model', capabilities: { input: { text: true, binary: true } } };
    models.alias = { id: 'model', name: 'Duplicate model' };
    models.__proto__ = { id: 'unsafe', name: 'Unsafe' };
    models.control = { id: 'bad\u0001id', name: 'Control' };
    models.variants = { id: 'variants', name: 'Variants', variants: { safe: {}, constructor: {}, broken: 'value' } };
    const defaults = Object.create(null);
    defaults.provider = 'model';
    defaults.unknown = 'model';
    defaults.__proto__ = 'model';

    const result = projectProviderCatalog({
      providers: [
        { id: 'provider', name: 'Provider', models },
        { id: 'provider', name: 'Duplicate provider', models: {} },
        { id: 'bad\u0001provider', name: 'Control provider', models: {} },
      ],
      default: defaults,
    });

    expect(result.partial).toBe(true);
    expect(Object.keys(result.providers)).toEqual(['0']);
    expect(Object.keys(result.providers[0].models)).toEqual(['good', 'variants']);
    expect(result.default).toEqual({ provider: 'model' });
    expect(Object.getPrototypeOf(result.providers[0].models)).toBe(null);
    expect(Object.getPrototypeOf(result.default)).toBe(null);
  });

  test('preserves finite numeric boundaries and keeps JSON output free of rejected values', () => {
    const result = projectProviderCatalog({
      providers: [{
        id: 'provider',
        name: 'Provider'.repeat(128),
        models: {
          model: {
            id: 'model',
            name: 'Model'.repeat(128),
            cost: { input: -1_000_000_000, output: 1_000_000_000, cache: { read: Infinity } },
            limit: { context: -1_000_000_000, output: 1_000_000_001 },
            release_date: '2026-01-01\u0007',
          },
        },
      }],
      default: { provider: 'model' },
    });

    // Soft numeric/release stripping alone is not partial.
    expect(result.partial).toBe(false);
    expect(result.providers[0].models.model.cost).toEqual({ input: -1_000_000_000, output: 1_000_000_000 });
    expect(result.providers[0].models.model.limit).toEqual({ context: -1_000_000_000 });
    expect(JSON.stringify(result)).not.toContain('Infinity');
    expect(JSON.stringify(result)).not.toContain('\u0007');
  });

  test('treats empty/null release_date as absent without marking the catalog partial', () => {
    const result = projectProviderCatalog({
      providers: [{
        id: 'provider',
        name: 'Provider',
        models: {
          model: { id: 'model', name: 'Model', release_date: '' },
          nullable: { id: 'nullable', name: 'Nullable', release_date: null },
          other: { id: 'other', name: 'Other', release_date: '2026-01-01' },
        },
      }],
      default: { provider: 'model' },
    });

    expect(result.partial).toBe(false);
    expect(result.providers[0].models.model).toEqual({ id: 'model', name: 'Model' });
    expect(result.providers[0].models.nullable).toEqual({ id: 'nullable', name: 'Nullable' });
    expect(result.providers[0].models.other).toEqual({
      id: 'other',
      name: 'Other',
      release_date: '2026-01-01',
    });
  });
});
