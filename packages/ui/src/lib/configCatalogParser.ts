import type { ConfigCatalogCapabilities, ConfigCatalogModel, ConfigCatalogProvider, ProviderCatalog } from '@/types/configCatalog';

const MAX_PROVIDERS = 200;
const MAX_MODELS_PER_PROVIDER = 500;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_DISPLAY_NAME_LENGTH = 1024;
const MAX_RELEASE_DATE_LENGTH = 64;
const MAX_DEFAULTS = 100;
const MAX_VARIANTS = 100;

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MODALITIES = new Set(['text', 'audio', 'image', 'video', 'pdf']);
const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : undefined;

const identifier = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  return value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value.trim() === value
    && !hasControlCharacter(value)
    && !FORBIDDEN_KEYS.has(value)
    ? value
    : undefined;
};

const displayName = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_DISPLAY_NAME_LENGTH && value.trim() === value && !hasControlCharacter(value) ? value : undefined;

const releaseDate = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_RELEASE_DATE_LENGTH && value.trim() === value && !hasControlCharacter(value) ? value : undefined;

const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000_000 ? value : undefined;

const booleans = (value: unknown): Record<string, boolean> | undefined => {
  const input = record(value);
  if (!input) return undefined;
  const output: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(input)) {
    if (!MODALITIES.has(key) || typeof item !== 'boolean') continue;
    output[key] = item;
  }
  return Object.keys(output).length ? output : undefined;
};

const capabilities = (value: unknown): ConfigCatalogCapabilities | undefined => {
  const input = record(value);
  if (!input) return undefined;
  const output: ConfigCatalogCapabilities = {};
  for (const key of ['temperature', 'reasoning', 'attachment', 'toolcall'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') continue;
    output[key] = input[key];
  }
  const inputCapabilities = booleans(input.input);
  const outputCapabilities = booleans(input.output);
  if (inputCapabilities) output.input = inputCapabilities;
  if (outputCapabilities) output.output = outputCapabilities;
  return Object.keys(output).length ? output : undefined;
};

const model = (value: unknown): { value?: ConfigCatalogModel; partial: boolean } => {
  const input = record(value);
  const id = identifier(input?.id);
  const name = displayName(input?.name);
  if (!input || !id || !name) return { partial: true };
  const output: ConfigCatalogModel = { id, name };
  // Soft allowlist stripping of optional metadata must not mark partial; only structural
  // drops (invalid model identity, truncated variants) affect catalog completeness.
  let partial = false;
  const modelCapabilities = capabilities(input.capabilities);
  if (modelCapabilities) output.capabilities = modelCapabilities;
  const rawCost = record(input.cost);
  if (rawCost) {
    const cost: NonNullable<ConfigCatalogModel['cost']> = {};
    const costInput = number(rawCost.input); if (costInput !== undefined) cost.input = costInput;
    const costOutput = number(rawCost.output); if (costOutput !== undefined) cost.output = costOutput;
    const rawCache = record(rawCost.cache);
    if (rawCache) {
      const cache: { read?: number; write?: number } = {};
      const read = number(rawCache.read); if (read !== undefined) cache.read = read;
      const write = number(rawCache.write); if (write !== undefined) cache.write = write;
      if (Object.keys(cache).length) cost.cache = cache;
    }
    if (Object.keys(cost).length) output.cost = cost;
  }
  const rawLimit = record(input.limit);
  if (rawLimit) {
    const limit: NonNullable<ConfigCatalogModel['limit']> = {};
    const context = number(rawLimit.context); if (context !== undefined) limit.context = context;
    const limitOutput = number(rawLimit.output); if (limitOutput !== undefined) limit.output = limitOutput;
    if (Object.keys(limit).length) output.limit = limit;
  }
  // Empty/null/invalid release_date is treated as absent (common upstream placeholder), not partial.
  const safeReleaseDate = releaseDate(input.release_date);
  if (safeReleaseDate) output.release_date = safeReleaseDate;
  const rawVariants = record(input.variants);
  if (rawVariants) {
    const variants: Record<string, object> = {};
    for (const [index, [key, item]] of Object.entries(rawVariants).entries()) {
      if (index >= MAX_VARIANTS) {
        partial = true;
        break;
      }
      if (!identifier(key) || !record(item)) continue;
      variants[key] = {};
    }
    if (Object.keys(variants).length) output.variants = variants;
  }
  return { value: output, partial };
};

export const parseProviderCatalog = (value: unknown): ProviderCatalog => {
  const input = record(value);
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.providers) || !record(input.default) || typeof input.partial !== 'boolean') {
    throw new Error('Invalid provider catalog response');
  }
  const providers: ConfigCatalogProvider[] = [];
  const providerIDs = new Set<string>();
  let localPartial = input.providers.length > MAX_PROVIDERS;
  for (const [providerIndex, candidate] of input.providers.entries()) {
    if (providerIndex >= MAX_PROVIDERS) continue;
    const rawProvider = record(candidate);
    const id = identifier(rawProvider?.id);
    const name = displayName(rawProvider?.name);
    const rawModels = record(rawProvider?.models);
    if (!rawProvider || !id || !name || !rawModels || providerIDs.has(id)) { localPartial = true; continue; }
    providerIDs.add(id);
    const models: Record<string, ConfigCatalogModel> = {};
    const modelIDs = new Set<string>();
    for (const [modelIndex, [modelKey, candidateModel]] of Object.entries(rawModels).entries()) {
      if (modelIndex >= MAX_MODELS_PER_PROVIDER || !identifier(modelKey) || Object.prototype.hasOwnProperty.call(models, modelKey)) { localPartial = true; continue; }
      const parsed = model(candidateModel);
      localPartial ||= parsed.partial;
      if (!parsed.value || modelIDs.has(parsed.value.id)) { localPartial = true; continue; }
      modelIDs.add(parsed.value.id);
      models[modelKey] = parsed.value;
    }
    providers.push({ id, name, models });
  }
  const rawDefaults = record(input.default)!;
  const defaults: Record<string, string> = {};
  for (const [index, [key, value]] of Object.entries(rawDefaults).entries()) {
    const safeKey = identifier(key), safeValue = identifier(value);
    if (index >= MAX_DEFAULTS || !safeKey || !safeValue) { localPartial = true; continue; }
    defaults[safeKey] = safeValue;
  }
  return { schemaVersion: 1, providers, default: defaults, partial: input.partial || localPartial };
};
