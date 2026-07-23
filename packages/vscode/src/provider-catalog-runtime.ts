export type SafeModel = {
  id: string;
  name: string;
  capabilities?: {
    temperature?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    toolcall?: boolean;
    input?: Record<'text' | 'audio' | 'image' | 'video' | 'pdf', boolean>;
    output?: Record<'text' | 'audio' | 'image' | 'video' | 'pdf', boolean>;
  };
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  limit?: { context?: number; output?: number };
  release_date?: string;
  variants?: Record<string, Record<string, never>>;
};

export type ProviderCatalog = {
  schemaVersion: 1;
  providers: Array<{ id: string; name: string; models: Record<string, SafeModel> }>;
  default: Record<string, string>;
  partial: boolean;
};

const MAX_PROVIDERS = 200;
const MAX_MODELS_PER_PROVIDER = 500;
const MAX_VARIANTS_PER_MODEL = 100;
const MAX_DEFAULTS = 100;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_DISPLAY_NAME_LENGTH = 1024;
const MAX_RELEASE_DATE_LENGTH = 64;
const MAX_FINITE_NUMBER = 1_000_000_000;
const MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'] as const;
const DANGEROUS_IDENTIFIERS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_CHARACTERS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, 'u');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const createDictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

const safeIdentifier = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return undefined;
  if (value.trim() !== value || CONTROL_CHARACTERS.test(value) || DANGEROUS_IDENTIFIERS.has(value)) return undefined;
  return value;
};

const safeDisplayName = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_DISPLAY_NAME_LENGTH ? value : undefined;

const safeReleaseDate = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_RELEASE_DATE_LENGTH && !CONTROL_CHARACTERS.test(value)
    ? value
    : undefined;

const safeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_FINITE_NUMBER ? value : undefined;

const projectModalities = (value: unknown): Record<'text' | 'audio' | 'image' | 'video' | 'pdf', boolean> | undefined => {
  if (!isRecord(value)) return undefined;
  const modalities = createDictionary<boolean>() as Record<'text' | 'audio' | 'image' | 'video' | 'pdf', boolean>;
  let hasValue = false;
  for (const [key, modalityValue] of Object.entries(value)) {
    if (!(MODALITIES as readonly string[]).includes(key) || typeof modalityValue !== 'boolean') continue;
    modalities[key as typeof MODALITIES[number]] = modalityValue;
    hasValue = true;
  }
  return hasValue ? modalities : undefined;
};

const projectModel = (value: unknown): { model: SafeModel; partial: boolean } | null => {
  if (!isRecord(value)) return null;
  const id = safeIdentifier(value.id);
  const name = safeDisplayName(value.name);
  if (!id || !name) return null;

  const model: SafeModel = { id, name };
  // partial is structural only (e.g. variant truncation). Soft allowlist stripping of optional
  // metadata must not mark the catalog partial or UI refresh will retain a stale complete snapshot.
  let partial = false;
  if (value.capabilities !== undefined && isRecord(value.capabilities)) {
    const capabilities: NonNullable<SafeModel['capabilities']> = {};
    for (const key of ['temperature', 'reasoning', 'attachment', 'toolcall'] as const) {
      const capability = value.capabilities[key];
      if (typeof capability === 'boolean') capabilities[key] = capability;
    }
    for (const key of ['input', 'output'] as const) {
      const projected = projectModalities(value.capabilities[key]);
      if (projected) capabilities[key] = projected;
    }
    if (Object.keys(capabilities).length > 0) model.capabilities = capabilities;
  }

  if (value.cost !== undefined && isRecord(value.cost)) {
    const cost: NonNullable<SafeModel['cost']> = {};
    for (const key of ['input', 'output'] as const) {
      const amount = safeNumber(value.cost[key]);
      if (amount !== undefined) cost[key] = amount;
    }
    if (value.cost.cache !== undefined && isRecord(value.cost.cache)) {
      const cache: NonNullable<NonNullable<SafeModel['cost']>['cache']> = {};
      for (const key of ['read', 'write'] as const) {
        const amount = safeNumber(value.cost.cache[key]);
        if (amount !== undefined) cache[key] = amount;
      }
      if (Object.keys(cache).length > 0) cost.cache = cache;
    }
    if (Object.keys(cost).length > 0) model.cost = cost;
  }

  if (value.limit !== undefined && isRecord(value.limit)) {
    const limit: NonNullable<SafeModel['limit']> = {};
    for (const key of ['context', 'output'] as const) {
      const amount = safeNumber(value.limit[key]);
      if (amount !== undefined) limit[key] = amount;
    }
    if (Object.keys(limit).length > 0) model.limit = limit;
  }

  // Empty/null/invalid release_date is a common upstream placeholder; treat as absent, not partial.
  if (value.release_date !== undefined && value.release_date !== '' && value.release_date !== null) {
    const releaseDate = safeReleaseDate(value.release_date);
    if (releaseDate) model.release_date = releaseDate;
  }

  if (value.variants !== undefined && isRecord(value.variants)) {
    const variants = createDictionary<Record<string, never>>();
    const entries = Object.entries(value.variants);
    if (entries.length > MAX_VARIANTS_PER_MODEL) partial = true;
    for (const [key, variant] of entries.slice(0, MAX_VARIANTS_PER_MODEL)) {
      const variantName = safeIdentifier(key);
      if (!variantName || !isRecord(variant) || Object.prototype.hasOwnProperty.call(variants, variantName)) {
        continue;
      }
      variants[variantName] = createDictionary<never>();
    }
    if (Object.keys(variants).length > 0) model.variants = variants;
  }
  return { model, partial };
};

export const projectProviderCatalog = (payload: unknown): ProviderCatalog => {
  if (!isRecord(payload) || !Array.isArray(payload.providers) || !isRecord(payload.default)) {
    throw new Error('Malformed OpenCode provider catalog response');
  }

  let partial = payload.providers.length > MAX_PROVIDERS;
  const providers: ProviderCatalog['providers'] = [];
  const providerIds = new Set<string>();
  const modelsByProvider = new Map<string, Set<string>>();
  for (const providerValue of payload.providers.slice(0, MAX_PROVIDERS)) {
    if (!isRecord(providerValue)) {
      partial = true;
      continue;
    }
    const id = safeIdentifier(providerValue.id);
    const name = safeDisplayName(providerValue.name);
    if (!id || !name || !isRecord(providerValue.models) || providerIds.has(id)) {
      partial = true;
      continue;
    }

    const entries = Object.entries(providerValue.models);
    if (entries.length > MAX_MODELS_PER_PROVIDER) partial = true;
    const models = createDictionary<SafeModel>();
    const modelIds = new Set<string>();
    for (const [modelKey, modelValue] of entries.slice(0, MAX_MODELS_PER_PROVIDER)) {
      const key = safeIdentifier(modelKey);
      const projectedModel = projectModel(modelValue);
      if (!key || !projectedModel || Object.prototype.hasOwnProperty.call(models, key) || modelIds.has(projectedModel?.model.id)) {
        partial = true;
        continue;
      }
      if (projectedModel.partial) partial = true;
      modelIds.add(projectedModel.model.id);
      models[key] = projectedModel.model;
    }
    providerIds.add(id);
    modelsByProvider.set(id, modelIds);
    providers.push({ id, name, models });
  }

  const defaults = createDictionary<string>();
  const defaultEntries = Object.entries(payload.default);
  if (defaultEntries.length > MAX_DEFAULTS) partial = true;
  for (const [key, value] of defaultEntries.slice(0, MAX_DEFAULTS)) {
    const providerId = safeIdentifier(key);
    const modelId = safeIdentifier(value);
    if (!providerId || !modelId || Object.prototype.hasOwnProperty.call(defaults, providerId) || !modelsByProvider.get(providerId)?.has(modelId)) {
      partial = true;
      continue;
    }
    defaults[providerId] = modelId;
  }
  return { schemaVersion: 1, providers, default: defaults, partial };
};
