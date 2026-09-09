const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const stringID = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

const listIncludesImage = (value) => Array.isArray(value)
  && value.some((item) => String(item).toLowerCase() === 'image');

/**
 * Vision capability projection.
 * Prefer authoritative OpenCode SDK Model.capabilities (`input.image` / `attachment`),
 * then fall back to legacy modalities/input/attachment shapes used by older fixtures.
 */
export function modelAcceptsImages(model) {
  if (!isRecord(model)) return false;
  if (isRecord(model.capabilities)) {
    if (isRecord(model.capabilities.input) && typeof model.capabilities.input.image === 'boolean') {
      return model.capabilities.input.image === true;
    }
    if (model.capabilities.attachment === true) return true;
  }
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
      const entry = {
        providerID,
        modelID,
        name: stringID(model.name) || modelID,
        acceptsImages: modelAcceptsImages(model),
      };
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

/** Bound provider/config catalog loads so a pending SDK call cannot stall a contact lane. */
export const CONNECTED_CATALOG_TIMEOUT_MS = 8_000;

const isAbortError = (error) => (
  error?.name === 'AbortError'
  || error?.code === 'ABORT_ERR'
  || (typeof error?.message === 'string' && /aborted|timed out/i.test(error.message))
);

/**
 * Load the connected catalog from an OpenCode SDK client.
 * Failure is distinct from a successful empty catalog.
 * Uses a bounded AbortSignal (default 8s) on provider.list + config.providers.
 *
 * @param {object} client
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 */
export async function loadConnectedCatalog(client, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : CONNECTED_CATALOG_TIMEOUT_MS;
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
    const listed = await client.provider.list({}, requestOptions);
    if (listed?.error || !isRecord(listed?.data)) {
      const error = new Error('OpenCode provider list is unavailable');
      error.code = 'upstream_error';
      throw error;
    }
    const configured = await client.config.providers({}, requestOptions);
    if (configured?.error || !isRecord(configured?.data)) {
      const error = new Error('OpenCode provider catalog is unavailable');
      error.code = 'upstream_error';
      throw error;
    }
    return projectConnectedModels({
      connected: listed.data.connected,
      providers: configured.data.providers,
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
