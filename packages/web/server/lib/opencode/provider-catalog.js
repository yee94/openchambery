const MAX_PROVIDERS = 200;
const MAX_MODELS_PER_PROVIDER = 500;
const MAX_DEFAULTS = 100;
const MAX_VARIANTS_PER_MODEL = 100;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_DISPLAY_NAME_LENGTH = 1_024;
const MAX_RELEASE_DATE_LENGTH = 64;
const MAX_ABSOLUTE_NUMBER = 1_000_000_000;
const MODALITIES = new Set(['text', 'audio', 'image', 'video', 'pdf']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownKeys = (value) => Object.keys(value);
const createDictionary = () => Object.create(null);

const isSafeIdentifier = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_IDENTIFIER_LENGTH
  && value.trim() === value
  && !/[\u0000-\u001f\u007f]/u.test(value)
  && value !== '__proto__'
  && value !== 'constructor'
  && value !== 'prototype';

const isSafeDisplayName = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_DISPLAY_NAME_LENGTH
  && !/[\u0000-\u001f\u007f]/u.test(value);

const isSafeReleaseDate = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_RELEASE_DATE_LENGTH
  && value.trim() === value
  && !/[\u0000-\u001f\u007f]/u.test(value);

const isSafeNumber = (value) => typeof value === 'number'
  && Number.isFinite(value)
  && Math.abs(value) <= MAX_ABSOLUTE_NUMBER;

const projectBooleanFields = (source, fields) => {
  if (!isRecord(source)) return undefined;
  const projected = createDictionary();
  for (const field of fields) {
    if (!Object.hasOwn(source, field)) continue;
    if (typeof source[field] === 'boolean') projected[field] = source[field];
  }
  return ownKeys(projected).length > 0 ? projected : undefined;
};

const projectModalities = (source) => {
  if (!isRecord(source)) return undefined;
  const projected = createDictionary();
  for (const key of ownKeys(source)) {
    if (!MODALITIES.has(key) || !isSafeIdentifier(key) || typeof source[key] !== 'boolean') continue;
    projected[key] = source[key];
  }
  return ownKeys(projected).length > 0 ? projected : undefined;
};

const projectCapabilities = (source) => {
  if (!isRecord(source)) return undefined;
  const capabilities = createDictionary();
  const flags = projectBooleanFields(source, ['temperature', 'reasoning', 'attachment', 'toolcall']);
  if (flags) Object.assign(capabilities, flags);
  for (const field of ['input', 'output']) {
    if (!Object.hasOwn(source, field)) continue;
    const modalities = projectModalities(source[field]);
    if (modalities) capabilities[field] = modalities;
  }
  return ownKeys(capabilities).length > 0 ? capabilities : undefined;
};

const projectCost = (source) => {
  if (!isRecord(source)) return undefined;
  const cost = createDictionary();
  for (const field of ['input', 'output']) {
    if (!Object.hasOwn(source, field)) continue;
    if (isSafeNumber(source[field])) cost[field] = source[field];
  }
  if (Object.hasOwn(source, 'cache') && isRecord(source.cache)) {
    const cache = createDictionary();
    for (const field of ['read', 'write']) {
      if (!Object.hasOwn(source.cache, field)) continue;
      if (isSafeNumber(source.cache[field])) cache[field] = source.cache[field];
    }
    if (ownKeys(cache).length > 0) cost.cache = cache;
  }
  return ownKeys(cost).length > 0 ? cost : undefined;
};

function projectModel(source) {
  if (!isRecord(source) || !isSafeIdentifier(source.id) || !isSafeDisplayName(source.name)) return null;
  // partial is structural only (e.g. variant truncation). Soft allowlist stripping of optional
  // metadata must not mark the catalog partial or UI refresh will retain a stale complete snapshot.
  let partial = false;
  const model = { id: source.id, name: source.name };
  if (Object.hasOwn(source, 'capabilities')) {
    const capabilities = projectCapabilities(source.capabilities);
    if (capabilities) model.capabilities = capabilities;
  }
  if (Object.hasOwn(source, 'cost')) {
    const cost = projectCost(source.cost);
    if (cost) model.cost = cost;
  }
  if (Object.hasOwn(source, 'limit') && isRecord(source.limit)) {
    const limit = createDictionary();
    for (const field of ['context', 'output']) {
      if (!Object.hasOwn(source.limit, field)) continue;
      if (isSafeNumber(source.limit[field])) limit[field] = source.limit[field];
    }
    if (ownKeys(limit).length > 0) model.limit = limit;
  }
  // Empty/null/invalid release_date is a common upstream placeholder; treat as absent, not partial.
  if (Object.hasOwn(source, 'release_date') && source.release_date !== '' && source.release_date !== null) {
    if (isSafeReleaseDate(source.release_date)) model.release_date = source.release_date;
  }
  if (Object.hasOwn(source, 'variants') && isRecord(source.variants)) {
    const variants = createDictionary();
    let variantCount = 0;
    for (const variantName of ownKeys(source.variants)) {
      if (variantCount >= MAX_VARIANTS_PER_MODEL) {
        partial = true;
        break;
      }
      variantCount += 1;
      if (isSafeIdentifier(variantName)) variants[variantName] = createDictionary();
    }
    if (ownKeys(variants).length > 0) model.variants = variants;
  }
  return { value: model, partial };
}

export function projectProviderCatalog(source) {
  if (!isRecord(source) || !Array.isArray(source.providers) || !isRecord(source.default)) return { ok: false };

  let partial = source.providers.length > MAX_PROVIDERS;
  const providers = [];
  const providerIds = new Set();
  for (const provider of source.providers.slice(0, MAX_PROVIDERS)) {
    if (!isRecord(provider) || !isSafeIdentifier(provider.id) || !isSafeDisplayName(provider.name) || !isRecord(provider.models) || providerIds.has(provider.id)) {
      partial = true;
      continue;
    }
    providerIds.add(provider.id);
    const models = createDictionary();
    const modelKeys = new Set();
    const modelIds = new Set();
    let modelCount = 0;
    for (const modelKey of ownKeys(provider.models)) {
      if (modelCount >= MAX_MODELS_PER_PROVIDER) {
        partial = true;
        break;
      }
      modelCount += 1;
      if (!isSafeIdentifier(modelKey) || modelKeys.has(modelKey)) {
        partial = true;
        continue;
      }
      modelKeys.add(modelKey);
      const model = projectModel(provider.models[modelKey]);
      if (!model || modelIds.has(model.value.id)) {
        partial = true;
        continue;
      }
      modelIds.add(model.value.id);
      partial ||= model.partial;
      models[modelKey] = model.value;
    }
    providers.push({ id: provider.id, name: provider.name, models });
  }

  const defaults = createDictionary();
  let defaultCount = 0;
  for (const key of ownKeys(source.default)) {
    if (defaultCount >= MAX_DEFAULTS) {
      partial = true;
      break;
    }
    defaultCount += 1;
    const value = source.default[key];
    if (isSafeIdentifier(key) && isSafeIdentifier(value)) defaults[key] = value;
    else partial = true;
  }
  return { ok: true, value: { schemaVersion: 1, providers, default: defaults, partial } };
}
