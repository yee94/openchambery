const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const stringID = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

const listIncludesImage = (value) => Array.isArray(value)
  && value.some((item) => String(item).toLowerCase() === 'image');

/**
 * ModelInfo.capabilities.input includes "image" for vision-capable models.
 * Do not treat model titles or unrelated flags as vision isolation.
 */
function modelAcceptsImages(model) {
  if (!isRecord(model)) return false;
  if (isRecord(model.capabilities) && listIncludesImage(model.capabilities.input)) return true;
  // Defensive: older projected shapes may still carry modalities/input.
  if (isRecord(model.modalities) && listIncludesImage(model.modalities.input)) return true;
  if (listIncludesImage(model.input)) return true;
  return false;
}

/**
 * Project official v2 provider.list + model.list into the LLM gateway catalog.
 *
 * ModelInfo.id is the external modelID used in generate/session model refs.
 * ModelInfo.modelID is a separate internal field and must not be preferred.
 *
 * @param {{
 *   providers?: unknown,
 *   models?: unknown,
 * }} source
 */
export function projectConnectedModels(source) {
  const providersIn = Array.isArray(source?.providers) ? source.providers : [];
  const modelsIn = Array.isArray(source?.models) ? source.models : [];

  const providerMeta = new Map();
  for (const provider of providersIn) {
    if (!isRecord(provider)) continue;
    const providerID = stringID(provider.id);
    if (!providerID) continue;
    providerMeta.set(providerID, {
      id: providerID,
      name: stringID(provider.name) || providerID,
    });
  }

  const models = [];
  const modelsByProvider = new Map();
  for (const model of modelsIn) {
    if (!isRecord(model)) continue;
    const providerID = stringID(model.providerID);
    // External model id for generate.text / session model refs.
    const modelID = stringID(model.id);
    if (!providerID || !modelID) continue;
    if (providerMeta.size > 0 && !providerMeta.has(providerID)) continue;
    const name = stringID(model.name) || modelID;
    const entry = {
      providerID,
      modelID,
      name,
      acceptsImages: modelAcceptsImages(model),
    };
    models.push(entry);
    if (!modelsByProvider.has(providerID)) modelsByProvider.set(providerID, []);
    modelsByProvider.get(providerID).push({ id: modelID, name });
  }

  const connected = [];
  const providers = [];
  const providerIDs = providerMeta.size > 0
    ? [...providerMeta.keys()]
    : [...modelsByProvider.keys()];
  for (const providerID of providerIDs) {
    const meta = providerMeta.get(providerID) || { id: providerID, name: providerID };
    const providerModels = modelsByProvider.get(providerID) || [];
    if (providerModels.length === 0 && providerMeta.size > 0) {
      // Provider listed with zero models is still "connected" but contributes no entries.
      connected.push(providerID);
      providers.push({ id: meta.id, name: meta.name, models: [] });
      continue;
    }
    if (providerModels.length === 0) continue;
    connected.push(providerID);
    providers.push({
      id: meta.id,
      name: meta.name,
      models: providerModels,
    });
  }

  return { connected, providers, models };
}

export function parseModelRef(model, providerID, modelID) {
  const explicitProvider = stringID(providerID);
  const explicitModel = stringID(modelID);
  if (explicitProvider && explicitModel) {
    return { providerID: explicitProvider, modelID: explicitModel };
  }
  const raw = stringID(model);
  if (!raw) return null;
  const slash = raw.indexOf('/');
  if (slash > 0) {
    return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
  }
  if (explicitProvider && raw) {
    return { providerID: explicitProvider, modelID: raw };
  }
  return null;
}

export function isConnectedModel(catalog, providerID, modelID) {
  if (!catalog || !stringID(providerID) || !stringID(modelID)) return false;
  return catalog.models.some((entry) => entry.providerID === providerID && entry.modelID === modelID);
}

/**
 * Load the connected catalog from an official `@opencode-ai/client`.
 * Uses model.list + provider.list only (no config.providers).
 * Failure is distinct from a successful empty catalog.
 *
 * Real client returns `{ location, data }` and throws declared JSON errors
 * (no `{ error }` envelope).
 *
 * @param {object} client
 * @param {{ directory?: string, workspace?: string } | undefined} [location]
 */
export async function loadConnectedCatalog(client, location) {
  const request = location ? { location } : undefined;
  let providersResult;
  let modelsResult;
  try {
    [providersResult, modelsResult] = await Promise.all([
      client.provider.list(request),
      client.model.list(request),
    ]);
  } catch (error) {
    const upstream = new Error(
      typeof error?.message === 'string' && error.message.trim()
        ? error.message
        : 'OpenCode provider catalog is unavailable',
    );
    upstream.code = 'upstream_error';
    upstream.cause = error;
    throw upstream;
  }
  if (!Array.isArray(providersResult?.data) || !Array.isArray(modelsResult?.data)) {
    const error = new Error('OpenCode provider catalog is unavailable');
    error.code = 'upstream_error';
    throw error;
  }
  return projectConnectedModels({
    providers: providersResult.data,
    models: modelsResult.data,
  });
}
