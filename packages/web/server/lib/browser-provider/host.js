/**
 * In-process host for extensions that answer agent `browser.*` actions.
 *
 * There is no guest process manager here. An installed extension registers a
 * declaration plus either an `answer` function or a loopback `endpoint`. The
 * host does not drive the in-app browser pane. No selected provider is an
 * explicit refusal, never an empty success and never a hidden builtin run.
 */

import crypto from 'node:crypto';

import {
  BROWSER_PROVIDER_ACTION_TIMEOUT_MS,
  BROWSER_PROVIDER_OPEN_TIMEOUT_MS,
  BROWSER_PROVIDER_RESPONSE_MAX,
  BrowserProviderError,
  extensionDeclaresBrowser,
  normalizeBrowserAction,
  parseBrowserProviderResult,
  readBrowserProviderContext,
  readBrowserProviderId,
  resolveBrowserProviderEndpoint,
  toPublicBrowserProvider,
} from './contract.js';

const catalogUnavailable = () => new BrowserProviderError(
  'OpenChamber could not read the browser provider catalog, so the action was not run. Try again.',
  { code: 'CATALOG_UNAVAILABLE', status: 503 },
);

const notSent = (message, code, status) => new BrowserProviderError(
  `${message} Nothing was changed.`,
  { code, status },
);

/**
 * @param {{
 *   readInstalled?: (records: object[]) => Promise<object[]> | object[],
 *   createId?: () => string,
 *   fetchImpl?: typeof fetch,
 *   selectionStore?: { read: () => Promise<string | null>, write: (id: string) => Promise<void> } | null,
 * }} [options]
 */
export const createBrowserProviderHost = ({
  readInstalled = (records) => records,
  createId = () => crypto.randomUUID(),
  fetchImpl = globalThis.fetch,
  selectionStore: initialSelectionStore = null,
} = {}) => {
  /** @type {Map<string, object>} */
  const installed = new Map();
  /** @type {string | null} */
  let selectedId = null;
  let selectionStore = initialSelectionStore;
  /** @type {Promise<void> | null} */
  let selectionLoad = null;

  const loadRecords = async () => {
    let records;
    try {
      records = await readInstalled([...installed.values()]);
    } catch {
      throw catalogUnavailable();
    }
    if (!Array.isArray(records)) throw catalogUnavailable();
    return records;
  };

  const ensureSelectionLoaded = async () => {
    if (!selectionStore) return;
    if (!selectionLoad) {
      const store = selectionStore;
      selectionLoad = Promise.resolve().then(() => store.read()).then((saved) => {
        if (selectedId === null) {
          const id = readBrowserProviderId(saved);
          if (id) selectedId = id;
        }
      }).catch((error) => {
        selectionLoad = null;
        throw error;
      });
    }
    try {
      await selectionLoad;
    } catch {
      throw catalogUnavailable();
    }
  };

  const list = async () => {
    const records = await loadRecords();
    const providers = [];
    for (const record of records) {
      const pub = toPublicBrowserProvider(record);
      if (pub) providers.push(pub);
    }
    return providers;
  };

  const findServing = async (id) => {
    const records = await loadRecords();
    for (const record of records) {
      const pub = toPublicBrowserProvider(record);
      if (pub && pub.id === id) return { public: pub, record };
    }
    return null;
  };

  return {
    /**
     * Register an installed extension. A declaration that does not provide
     * browser is rejected; it is not stored and it is not reported as success.
     *
     * @param {object} declaration
     */
    install(declaration) {
      if (!extensionDeclaresBrowser(declaration)) {
        throw new BrowserProviderError(
          'This extension does not declare that it provides browser, so it was not registered.',
          { code: 'INVALID_DECLARATION', status: 400 },
        );
      }
      if (declaration?.enabled === false) {
        throw new BrowserProviderError(
          'This extension is not enabled, so it was not registered as a browser provider.',
          { code: 'INVALID_DECLARATION', status: 400 },
        );
      }
      const pub = toPublicBrowserProvider({ ...declaration, enabled: true });
      if (!pub) {
        const endpoint = declaration?.endpoint;
        if (typeof endpoint === 'string' && !resolveBrowserProviderEndpoint(endpoint)) {
          throw new BrowserProviderError(
            'A browser provider endpoint must be a loopback http(s) URL with no credentials. Nothing was registered.',
            { code: 'INVALID_DECLARATION', status: 400 },
          );
        }
        throw new BrowserProviderError(
          'This extension declares browser but cannot answer actions, so it was not registered.',
          { code: 'INVALID_DECLARATION', status: 400 },
        );
      }
      const endpoint = typeof declaration.endpoint === 'string'
        ? resolveBrowserProviderEndpoint(declaration.endpoint)
        : null;
      installed.set(pub.id, {
        id: pub.id,
        name: pub.name,
        enabled: true,
        service: { provides: ['browser'] },
        answer: typeof declaration.answer === 'function' ? declaration.answer : null,
        endpoint,
      });
      return pub;
    },

    list,

    attachSelectionStore(store) {
      selectionStore = store;
      selectionLoad = null;
    },

    selectedId() {
      return selectedId;
    },

    /**
     * Catalog the settings page reads. `selectedId` is null unless that id is
     * in `providers`, so a saved choice for a missing extension is not shown
     * as a connected browser.
     */
    async catalog() {
      await ensureSelectionLoaded();
      const providers = await list();
      const visible = providers.some((provider) => provider.id === selectedId) ? selectedId : null;
      return { providers, selectedId: visible };
    },

    /**
     * Choose which installed provider answers later agent actions.
     * An unknown or invalid id does not change the choice. The choice is not
     * cleared by this call; a missing extension stays saved but is not listed
     * as connected until it is registered again.
     *
     * @param {string} providerId
     */
    async select(providerId) {
      await ensureSelectionLoaded();
      const id = readBrowserProviderId(providerId);
      if (!id) {
        throw new BrowserProviderError(
          'id must be a browser provider id. The selection was not changed.',
          { code: 'INVALID_SELECTION', status: 400 },
        );
      }
      const match = await findServing(id);
      if (!match) {
        throw new BrowserProviderError(
          `No browser provider "${id}" is installed, so the selection was not changed.`,
          { code: 'PROVIDER_NOT_FOUND', status: 404 },
        );
      }
      if (selectionStore) {
        try {
          await selectionStore.write(match.public.id);
        } catch {
          throw new BrowserProviderError(
            'The browser provider selection could not be saved, so it was not changed.',
            { code: 'SELECTION_UNAVAILABLE', status: 503 },
          );
        }
      }
      selectedId = match.public.id;
      return selectedId;
    },

    /**
     * Send one agent browser action to the selected provider and return that
     * provider's data. No provider, a catalog read failure, or an unusable
     * answer rejects. This never calls the in-app browser pane.
     *
     * @param {{
     *   action: unknown,
     *   parameters?: unknown,
     *   context?: unknown,
     *   providerId?: unknown,
     *   signal?: AbortSignal,
     *   timeoutMs?: number,
     * }} input
     */
    async dispatchAgentBrowserAction(input = {}) {
      const normalized = normalizeBrowserAction(input.action, input.parameters);
      if (input.signal?.aborted) {
        throw notSent('The action was cancelled before it was sent.', 'CANCELLED', 499);
      }
      await ensureSelectionLoaded();

      const explicitId = readBrowserProviderId(input.providerId);
      const providerId = explicitId || selectedId;
      if (!providerId) {
        throw notSent(
          'No browser provider is selected, so the action was not run.',
          'NO_PROVIDER',
          409,
        );
      }

      const match = await findServing(providerId);
      if (!match) {
        throw notSent(
          `Browser provider "${providerId}" is not available, so the action was not run.`,
          'PROVIDER_NOT_FOUND',
          404,
        );
      }

      const request = {
        requestId: createId(),
        action: normalized.action,
        parameters: normalized.parameters,
        context: readBrowserProviderContext(input.context),
      };
      const timeoutMs = input.timeoutMs
        ?? (normalized.action === 'browser.open'
          ? BROWSER_PROVIDER_OPEN_TIMEOUT_MS
          : BROWSER_PROVIDER_ACTION_TIMEOUT_MS);
      const raw = await askProvider(match.record, request, {
        timeoutMs,
        signal: input.signal,
        fetchImpl,
        providerName: match.public.name,
      });
      const parsed = parseBrowserProviderResult(raw);
      if (!parsed) {
        throw new BrowserProviderError(
          `The browser provider "${match.public.name}" answered something that is not a browser result. Nothing is known about the page.`,
          { code: 'UNKNOWN_RESULT', status: 502 },
        );
      }
      if (!parsed.ok) {
        throw new BrowserProviderError(parsed.error, { code: 'PROVIDER_REJECTED', status: 400 });
      }
      return { providerId: match.public.id, data: parsed.data };
    },
  };
};

let singleton = null;

/** Process host used by routes. Tests construct their own host and do not call this. */
export const getBrowserProviderHost = () => {
  if (!singleton) singleton = createBrowserProviderHost();
  return singleton;
};

const connectionNeverStarted = (error) => {
  const code = error?.cause?.code || error?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'EADDRNOTAVAIL';
};

const askProvider = async (record, request, { timeoutMs, signal, fetchImpl, providerName }) => {
  const body = JSON.stringify(request);
  if (typeof record.answer === 'function') {
    return callAnswer(record.answer, request, { timeoutMs, signal, providerName });
  }
  if (record.endpoint) {
    return postEndpoint(record.endpoint, body, { timeoutMs, signal, fetchImpl, providerName });
  }
  throw notSent(
    `The browser provider "${providerName}" cannot be reached, so the action was not run.`,
    'PROVIDER_UNAVAILABLE',
    503,
  );
};

const lostAnswer = (providerName) => new BrowserProviderError(
  `The browser provider "${providerName}" was sent this action but no answer came back, so it may or may not have run; read the page before repeating it.`,
  { code: 'REQUEST_FAILED', status: 504 },
);

const callAnswer = async (answer, request, { timeoutMs, signal, providerName }) => {
  let timer;
  let onAbort;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
      }, timeoutMs);
      if (signal) {
        onAbort = () => reject(Object.assign(new Error('aborted'), { code: 'ABORT' }));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      Promise.resolve().then(() => answer(request)).then(resolve, reject);
    });
  } catch (error) {
    if (error instanceof BrowserProviderError) throw error;
    throw lostAnswer(providerName);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
};

const postEndpoint = async (endpoint, body, { timeoutMs, signal, fetchImpl, providerName }) => {
  const url = resolveBrowserProviderEndpoint(endpoint);
  if (!url) {
    throw notSent(
      `The browser provider "${providerName}" cannot be reached, so the action was not run.`,
      'PROVIDER_UNAVAILABLE',
      503,
    );
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signals = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body,
      signal: signals,
    });
  } catch (error) {
    if (connectionNeverStarted(error)) {
      throw notSent(
        `The browser provider "${providerName}" could not be reached, so the action was not run.`,
        'PROVIDER_UNAVAILABLE',
        503,
      );
    }
    throw new BrowserProviderError(
      `The browser provider "${providerName}" was sent this action but no answer came back, so it may or may not have run; read the page before repeating it.`,
      { code: 'REQUEST_FAILED', status: 504 },
    );
  }
  if (response.status !== 200) {
    throw new BrowserProviderError(
      `The browser provider "${providerName}" answered HTTP ${response.status} instead of a result. Nothing is known about the page.`,
      { code: 'UNKNOWN_RESULT', status: 502 },
    );
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > BROWSER_PROVIDER_RESPONSE_MAX) {
    throw new BrowserProviderError(
      `The browser provider "${providerName}" answered something that is not a browser result. Nothing is known about the page.`,
      { code: 'UNKNOWN_RESULT', status: 502 },
    );
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new BrowserProviderError(
      `The browser provider "${providerName}" was sent this action but no answer came back, so it may or may not have run; read the page before repeating it.`,
      { code: 'REQUEST_FAILED', status: 504 },
    );
  }
  if (text.length > BROWSER_PROVIDER_RESPONSE_MAX) {
    throw new BrowserProviderError(
      `The browser provider "${providerName}" answered something that is not a browser result. Nothing is known about the page.`,
      { code: 'UNKNOWN_RESULT', status: 502 },
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BrowserProviderError(
      `The browser provider "${providerName}" answered something that is not a browser result. Nothing is known about the page.`,
      { code: 'UNKNOWN_RESULT', status: 502 },
    );
  }
};
