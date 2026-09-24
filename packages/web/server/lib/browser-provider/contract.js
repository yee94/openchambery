/**
 * Narrow contract for an installed extension that answers agent browser actions.
 *
 * This fork has no guest SDK and no `service.provides` platform. A declaration
 * is recognized when `service.provides`, top-level `provides`, or
 * `contributes.service.provides` includes `"browser"`. The first of those that
 * is an array wins, so a service contribution is not overridden by a looser
 * field. The host posts the same envelope upstream posts to `POST /browser-control`.
 */

const BROWSER_PROVIDER_ROLE = 'browser';

/** Path on an extension loopback the host posts every action to. */
export const BROWSER_PROVIDER_PATH = '/browser-control';

export const BROWSER_PROVIDERS_ROUTE = '/api/browser-providers';
export const BROWSER_PROVIDER_SELECTION_ROUTE = '/api/browser-providers/selection';
export const BROWSER_PROVIDER_ACTIONS_ROUTE = '/api/browser-providers/actions';

/** Same id rule the settings catalog parser accepts. */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROVIDER_NAME_MAX = 200;

const BROWSER_CONTROL_ACTIONS = [
  'browser.open',
  'browser.snapshot',
  'browser.click',
  'browser.type',
  'browser.scroll',
  'browser.back',
  'browser.forward',
  'browser.inspect',
  'browser.capture',
  'browser.resize',
];

const BROWSER_VIEWPORT_MODES = ['mobile', 'tablet', 'desktop', 'fill'];
const BROWSER_SCROLL_DIRECTIONS = ['up', 'down', 'top', 'bottom'];

export const BROWSER_PROVIDER_OPEN_TIMEOUT_MS = 45_000;
export const BROWSER_PROVIDER_ACTION_TIMEOUT_MS = 20_000;
/** A screenshot is the largest answer the host will accept. */
export const BROWSER_PROVIDER_RESPONSE_MAX = 12_000_000;

const CONTROL_ACTIONS = new Set(BROWSER_CONTROL_ACTIONS);

export class BrowserProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, status: number }} details
   */
  constructor(message, { code, status }) {
    super(message);
    this.name = 'BrowserProviderError';
    this.code = code;
    this.status = status;
  }
}

const isBrowserControlAction = (value) => (
  typeof value === 'string' && CONTROL_ACTIONS.has(value)
);

/**
 * Roles an extension claims. `null` means the object does not declare a
 * provides list at all — that is not the same as declaring an empty one.
 *
 * @param {unknown} declaration
 * @returns {unknown[] | null}
 */
const readDeclaredProvides = (declaration) => {
  if (!declaration || typeof declaration !== 'object') return null;
  const record = /** @type {{ service?: { provides?: unknown }, provides?: unknown, contributes?: { service?: { provides?: unknown } } }} */ (declaration);
  if (Array.isArray(record.service?.provides)) return record.service.provides;
  if (Array.isArray(record.provides)) return record.provides;
  if (Array.isArray(record.contributes?.service?.provides)) return record.contributes.service.provides;
  return null;
};

/** Whether this declaration says the extension provides the browser role. */
export const extensionDeclaresBrowser = (declaration) => {
  const provides = readDeclaredProvides(declaration);
  return Boolean(provides?.some((role) => role === BROWSER_PROVIDER_ROLE));
};

/**
 * @param {string} endpoint
 * @returns {string | null} Absolute loopback URL, or null when it must not be called.
 */
export const resolveBrowserProviderEndpoint = (endpoint) => {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null;
  if (parsed.pathname === '/' || parsed.pathname === '') {
    parsed.pathname = BROWSER_PROVIDER_PATH;
  }
  return parsed.toString();
};

export const readBrowserProviderId = (value) => (
  typeof value === 'string' && PROVIDER_ID_PATTERN.test(value) ? value : null
);

const readProviderName = (value, id) => {
  if (typeof value !== 'string') return id;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > PROVIDER_NAME_MAX) return null;
  return trimmed;
};

/**
 * Public row for settings and the rail. Transport details stay on the host.
 * A declaration the host cannot reach is not listed: offering it would look
 * like a connected browser that cannot answer.
 *
 * @param {unknown} record
 * @returns {{ id: string, name: string, surface: false } | null}
 */
export const toPublicBrowserProvider = (record) => {
  if (!record || typeof record !== 'object') return null;
  const row = /** @type {{ id?: unknown, name?: unknown, enabled?: unknown, answer?: unknown, endpoint?: unknown }} */ (record);
  if (row.enabled === false) return null;
  if (!extensionDeclaresBrowser(record)) return null;
  const id = readBrowserProviderId(row.id);
  if (!id) return null;
  const name = readProviderName(row.name, id);
  if (!name) return null;
  const endpoint = typeof row.endpoint === 'string' ? resolveBrowserProviderEndpoint(row.endpoint) : null;
  if (typeof row.answer !== 'function' && !endpoint) return null;
  // This host does not push frames. A true surface would make the rail open a
  // picture that does not exist.
  return { id, name, surface: false };
};

/**
 * @param {unknown} value
 * @returns {{ directory: string | null, sessionId: string | null }}
 */
export const readBrowserProviderContext = (value) => {
  const record = value && typeof value === 'object'
    ? /** @type {{ directory?: unknown, sessionId?: unknown }} */ (value)
    : {};
  const directory = record.directory;
  const sessionId = record.sessionId;
  return {
    directory: typeof directory === 'string' && directory.length > 0 ? directory : null,
    sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
  };
};

/**
 * Extension-side read of the body the host posts. `null` is not a browser action.
 *
 * @param {string} body
 */
export const readBrowserProviderRequest = (body) => {
  let wire;
  try {
    wire = JSON.parse(body);
  } catch {
    return null;
  }
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
  const { requestId, action, parameters, context } = wire;
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  if (!isBrowserControlAction(action)) return null;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return null;
  return {
    requestId,
    action,
    parameters,
    context: readBrowserProviderContext(context),
  };
};

/**
 * Host-side read of an extension answer. `null` is not a browser result.
 *
 * @param {unknown} value
 * @returns {{ ok: true, data: Record<string, unknown> } | { ok: false, error: string } | null}
 */
export const parseBrowserProviderResult = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = /** @type {{ ok?: unknown, data?: unknown, error?: unknown }} */ (value);
  if (row.ok === true) {
    if (!row.data || typeof row.data !== 'object' || Array.isArray(row.data)) return null;
    return { ok: true, data: /** @type {Record<string, unknown>} */ (row.data) };
  }
  if (row.ok === false) {
    if (typeof row.error !== 'string' || row.error.length === 0 || row.error.length > 2_000) return null;
    return { ok: false, error: row.error };
  }
  return null;
};

const invalidAction = (message) => new BrowserProviderError(message, { code: 'INVALID_ACTION', status: 400 });

const readOptionalString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);

const readViewport = (value, required) => {
  const viewport = readOptionalString(value);
  if (!viewport) {
    if (required) throw invalidAction('viewport is required for browser.resize. Nothing was sent.');
    return undefined;
  }
  if (!BROWSER_VIEWPORT_MODES.includes(viewport)) {
    throw invalidAction('viewport must be mobile, tablet, desktop, or fill. Nothing was sent.');
  }
  return viewport;
};

/**
 * Validates an agent action before it is sent. The object returned is the
 * only parameters the extension sees.
 *
 * @param {unknown} action
 * @param {unknown} parameters
 * @returns {{ action: string, parameters: Record<string, unknown> }}
 */
export const normalizeBrowserAction = (action, parameters) => {
  if (!isBrowserControlAction(action)) {
    throw invalidAction('Unknown browser action. Nothing was sent.');
  }
  const input = parameters == null ? {} : parameters;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidAction('parameters must be an object. Nothing was sent.');
  }
  const source = /** @type {Record<string, unknown>} */ (input);
  /** @type {Record<string, unknown>} */
  const next = {};

  if (action === 'browser.resize') {
    next.viewport = readViewport(source.viewport, true);
  }

  if (action === 'browser.capture') {
    const label = readOptionalString(source.label);
    if (label) next.label = label;
  }

  if (action === 'browser.open') {
    const viewport = readViewport(source.viewport, false);
    if (viewport) next.viewport = viewport;
    const url = readOptionalString(source.url);
    if (!url) throw invalidAction('url is required for browser.open. Nothing was sent.');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw invalidAction('url must be an absolute http(s) URL. Nothing was sent.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw invalidAction('url must use http or https. Nothing was sent.');
    }
    next.url = parsed.toString();
  }

  if (action === 'browser.click') {
    const selector = readOptionalString(source.selector);
    const text = readOptionalString(source.text);
    if (!selector && !text) {
      throw invalidAction('browser.click requires selector or text. Nothing was sent.');
    }
    if (selector) next.selector = selector;
    if (text) next.text = text;
  }

  if (action === 'browser.snapshot') {
    const selector = readOptionalString(source.selector);
    if (selector) next.selector = selector;
  }

  if (action === 'browser.inspect') {
    const selector = readOptionalString(source.selector);
    if (!selector) throw invalidAction('selector is required for browser.inspect. Nothing was sent.');
    next.selector = selector;
  }

  if (action === 'browser.type') {
    const selector = readOptionalString(source.selector);
    if (!selector) throw invalidAction('selector is required for browser.type. Nothing was sent.');
    if (typeof source.value !== 'string') {
      throw invalidAction('value is required for browser.type. Nothing was sent.');
    }
    next.selector = selector;
    next.value = source.value;
    next.submit = source.submit === true;
  }

  if (action === 'browser.scroll') {
    const selector = readOptionalString(source.selector);
    const direction = readOptionalString(source.direction);
    if (!selector && !direction) {
      throw invalidAction('browser.scroll requires direction or selector. Nothing was sent.');
    }
    if (direction && !BROWSER_SCROLL_DIRECTIONS.includes(direction)) {
      throw invalidAction('direction must be up, down, top, or bottom. Nothing was sent.');
    }
    if (selector) next.selector = selector;
    if (direction) next.direction = direction;
  }

  return { action, parameters: next };
};
