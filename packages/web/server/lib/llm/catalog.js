const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const stringID = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

const listIncludesImage = (value) => Array.isArray(value)
  && value.some((item) => String(item).toLowerCase() === 'image');

function modelAcceptsImages(model) {
  if (!isRecord(model)) return false;
  if (isRecord(model.modalities) && listIncludesImage(model.modalities.input)) return true;
  if (listIncludesImage(model.input)) return true;
  return model.attachment === true;
}

/**
 * Merge OpenCode `GET /provider` (connected ids) with `GET /config/providers`
 * (model catalog). Do not interpret plugin-specific provider configs.
 *
 * @param {{
 *   connected?: unknown,
 *   providers?: unknown,
 * }} source
 */
export function projectConnectedModels(source) {
  const connected = new Set(
    Array.isArray(source?.connected)
      ? source.connected.map(stringID).filter(Boolean)
      : [],
  );
  const models = [];
  const providers = [];
  const list = Array.isArray(source?.providers) ? source.providers : [];
  for (const provider of list) {
    if (!isRecord(provider)) continue;
    const providerID = stringID(provider.id);
    if (!providerID || !connected.has(providerID)) continue;
    const providerModels = [];
    const rawModels = isRecord(provider.models) ? Object.values(provider.models) : [];
    for (const model of rawModels) {
      if (!isRecord(model)) continue;
      const modelID = stringID(model.id);
      if (!modelID) continue;
      const entry = { providerID, modelID, name: stringID(model.name) || modelID, acceptsImages: modelAcceptsImages(model) };
      models.push(entry);
      providerModels.push({ id: modelID, name: entry.name });
    }
    providers.push({
      id: providerID,
      name: stringID(provider.name) || providerID,
      models: providerModels,
    });
  }
  return { connected: [...connected], providers, models };
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
 * Load the connected catalog from an OpenCode SDK client.
 * Failure is distinct from a successful empty catalog.
 */
export async function loadConnectedCatalog(client) {
  const listed = await client.provider.list({});
  if (listed?.error || !isRecord(listed?.data)) {
    const error = new Error('OpenCode provider list is unavailable');
    error.code = 'upstream_error';
    throw error;
  }
  const configured = await client.config.providers({});
  if (configured?.error || !isRecord(configured?.data)) {
    const error = new Error('OpenCode provider catalog is unavailable');
    error.code = 'upstream_error';
    throw error;
  }
  return projectConnectedModels({
    connected: listed.data.connected,
    providers: configured.data.providers,
  });
}
