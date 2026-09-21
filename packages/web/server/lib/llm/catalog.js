const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const stringID = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

const listIncludesImage = (value) => Array.isArray(value)
  && value.some((item) => String(item).toLowerCase() === 'image');

/**
 * Vision capability projection.
 * Prefer authoritative OpenCode Model.capabilities (`input.image` boolean /
 * `attachment`, or v2 list `input` containing `"image"`), then fall back to
 * legacy modalities/input/attachment shapes used by older fixtures.
 * Do not treat model titles or unrelated flags as vision isolation.
 */
export function modelAcceptsImages(model) {
  if (!isRecord(model)) return false;
  if (isRecord(model.capabilities)) {
    if (isRecord(model.capabilities.input) && typeof model.capabilities.input.image === 'boolean') {
      return model.capabilities.input.image === true;
    }
    if (listIncludesImage(model.capabilities.input)) return true;
    if (model.capabilities.attachment === true) return true;
  }
  if (isRecord(model.modalities) && listIncludesImage(model.modalities.input)) return true;
  if (listIncludesImage(model.input)) return true;
  return model.attachment === true;
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

/** Bound provider/model catalog loads so a pending SDK call cannot stall a contact lane. */
export const CONNECTED_CATALOG_TIMEOUT_MS = 8_000;

const isAbortError = (error) => (
  error?.name === 'AbortError'
  || error?.code === 'ABORT_ERR'
  || (typeof error?.message === 'string' && /aborted|timed out/i.test(error.message))
);

const resolveCatalogLocation = (options) => {
  if (!options || typeof options !== 'object') return undefined;
  if (isRecord(options.location)) return options.location;
  if (options.directory || options.workspace) {
    return {
      ...(options.directory ? { directory: options.directory } : {}),
      ...(options.workspace ? { workspace: options.workspace } : {}),
    };
  }
  return undefined;
};

/**
 * Load the connected catalog from an official `@opencode/client`.
 * Uses model.list + provider.list only (no config.providers).
 * Failure is distinct from a successful empty catalog.
 *
 * Real client returns `{ location, data }` and throws declared JSON errors
 * (no `{ error }` envelope). Uses a bounded AbortSignal (default 8s).
 *
 * @param {object} client
 * @param {{
 *   location?: { directory?: string, workspace?: string },
 *   directory?: string,
 *   workspace?: string,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} [options]
 */
export async function loadConnectedCatalog(client, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : CONNECTED_CATALOG_TIMEOUT_MS;
  const location = resolveCatalogLocation(options);
  const request = location ? { location } : undefined;
  const parentSignal = options.signal;
  const controller = new AbortController();
  const onParentAbort = () => {
    try {
      controller.abort(parentSignal?.reason instanceof Error
        ? parentSignal.reason
        : new Error('Connected catalog aborted'));
    } catch {
      // ignore
    }
  };
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    try {
      controller.abort(new Error(`Connected catalog timed out after ${timeoutMs}ms`));
    } catch {
      // ignore
    }
  }, timeoutMs);
  timer.unref?.();

  const requestOptions = { signal: controller.signal };
  try {
    let providersResult;
    let modelsResult;
    try {
      [providersResult, modelsResult] = await Promise.all([
        client.provider.list(request, requestOptions),
        client.model.list(request, requestOptions),
      ]);
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw error;
      }
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
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      const timedOut = typeof error?.message === 'string' && /timed out/i.test(error.message)
        || (controller.signal.reason instanceof Error && /timed out/i.test(controller.signal.reason.message));
      const next = new Error(
        timedOut
          ? `Connected catalog timed out after ${timeoutMs}ms`
          : 'Connected catalog request was aborted',
      );
      next.code = 'upstream_error';
      throw next;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.('abort', onParentAbort);
  }
}
