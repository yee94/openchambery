/**
 * Host-side OpenCode transport boundary (ticket 11).
 *
 * Proxy gates browser → OpenChamber → OpenCode. Background Host work
 * (queue / goal / scheduled / assistants / session-title) often calls OpenCode
 * directly and must share the same execution admission: verified contract only
 * for writes; diagnostics, reads, and stop-task stay available.
 */

import {
  runtimeContractExecutionBlockedBody,
  shouldBlockRuntimeContractExecution,
} from './runtime-contract.js';

/** @type {(() => (object | null | undefined)) | null} */
let registeredGetRuntimeContract = null;

/** @type {{ allowMissingContract?: boolean }} */
let registeredGateOptions = {};

/**
 * Wire once from the composition root so makeOpenCodeV2Client + serverOpenCodeFetch
 * share the live lifecycle contract without each caller threading deps.
 *
 * Production must not pass `allowMissingContract: true` — missing contract blocks
 * writes. Unit/DI factories may opt in when no lifecycle is configured.
 * @param {(() => (object | null | undefined)) | null} getter
 * @param {{ allowMissingContract?: boolean }} [options]
 */
export function configureServerOpenCodeFetchGate(getter, options = {}) {
  registeredGetRuntimeContract = typeof getter === 'function' ? getter : null;
  registeredGateOptions = {
    allowMissingContract: options?.allowMissingContract === true,
  };
}

export function getRegisteredRuntimeContract() {
  try {
    return registeredGetRuntimeContract ? registeredGetRuntimeContract() : null;
  } catch {
    return null;
  }
}

export function getRegisteredRuntimeContractGateOptions() {
  return { ...registeredGateOptions };
}

/**
 * @param {string | URL | Request} input
 * @param {RequestInit | undefined} init
 * @returns {{ method: string, pathWithQuery: string }}
 */
export function resolveFetchMethodAndPath(input, init) {
  const method = String(
    (init && typeof init.method === 'string' && init.method)
    || (typeof Request !== 'undefined' && input instanceof Request && input.method)
    || 'GET',
  ).toUpperCase();

  let urlString = '';
  if (typeof input === 'string') {
    urlString = input;
  } else if (typeof URL !== 'undefined' && input instanceof URL) {
    urlString = input.toString();
  } else if (typeof Request !== 'undefined' && input instanceof Request) {
    urlString = input.url;
  } else {
    urlString = String(input || '');
  }

  let pathWithQuery = urlString;
  try {
    const parsed = new URL(urlString, 'http://opencode.local');
    pathWithQuery = `${parsed.pathname}${parsed.search || ''}`;
  } catch {
    const stripped = urlString.replace(/^https?:\/\/[^/]+/i, '');
    pathWithQuery = stripped.startsWith('/') ? stripped : `/${stripped}`;
  }

  return { method, pathWithQuery };
}

/**
 * @param {{
 *   getRuntimeContract?: (() => (object | null | undefined)) | null,
 *   method: string,
 *   pathWithQuery: string,
 *   allowMissingContract?: boolean,
 * }} input
 */
export function assertServerOpenCodeExecutionAllowed(input) {
  const getter = input.getRuntimeContract || registeredGetRuntimeContract;
  let contract = null;
  try {
    contract = typeof getter === 'function' ? getter() : null;
  } catch {
    contract = null;
  }
  const allowMissingContract = typeof input.allowMissingContract === 'boolean'
    ? input.allowMissingContract
    : registeredGateOptions.allowMissingContract === true;
  if (!shouldBlockRuntimeContractExecution(input.method, input.pathWithQuery, contract, {
    allowMissingContract,
  })) {
    return null;
  }
  return runtimeContractExecutionBlockedBody(contract);
}

/**
 * Wrap fetch so host OpenCode SDK clients share proxy write admission.
 * @param {typeof fetch} [fetchImpl]
 * @param {{
 *   getRuntimeContract?: () => (object | null | undefined),
 *   allowMissingContract?: boolean,
 * }} [options]
 * @returns {typeof fetch}
 */
export function wrapFetchWithRuntimeContractGate(fetchImpl = fetch, options = {}) {
  const getRuntimeContract = options.getRuntimeContract || (() => getRegisteredRuntimeContract());
  const allowMissingContract = typeof options.allowMissingContract === 'boolean'
    ? options.allowMissingContract
    : registeredGateOptions.allowMissingContract === true;

  return async (input, init) => {
    const { method, pathWithQuery } = resolveFetchMethodAndPath(input, init);
    const blocked = assertServerOpenCodeExecutionAllowed({
      getRuntimeContract,
      method,
      pathWithQuery,
      allowMissingContract,
    });
    if (blocked) {
      return new Response(JSON.stringify(blocked), {
        status: 409,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      });
    }
    return fetchImpl(input, init);
  };
}

/**
 * High-level Host OpenCode JSON helper used by goal / title and tests.
 * @param {{
 *   buildOpenCodeUrl: (pathname: string, prefix?: string) => string,
 *   getOpenCodeAuthHeaders: () => Record<string, string>,
 *   getRuntimeContract?: () => (object | null | undefined),
 *   allowMissingContract?: boolean,
 *   fetchImpl?: typeof fetch,
 * }} deps
 */
export function createServerOpenCodeFetch(deps) {
  const {
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getRuntimeContract = () => getRegisteredRuntimeContract(),
    allowMissingContract,
    fetchImpl = fetch,
  } = deps;

  const gatedFetch = wrapFetchWithRuntimeContractGate(fetchImpl, {
    getRuntimeContract,
    allowMissingContract,
  });

  /**
   * @param {string} fetchPath
   * @param {{
   *   directory?: string | null,
   *   method?: string,
   *   body?: unknown,
   *   query?: Record<string, string> | URLSearchParams | null,
   *   signal?: AbortSignal,
   *   timeoutMs?: number,
   * }} [options]
   */
  const serverOpenCodeFetch = async (fetchPath, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    const base = buildOpenCodeUrl(fetchPath, '');
    const params = new URLSearchParams(options.query || {});
    if (options.directory) params.set('directory', options.directory);
    const search = params.toString();
    const url = search ? `${base}${base.includes('?') ? '&' : '?'}${search}` : base;

    const pathOnly = String(fetchPath || '').split('?')[0] || '';
    const blocked = assertServerOpenCodeExecutionAllowed({
      getRuntimeContract,
      method,
      pathWithQuery: pathOnly,
      allowMissingContract,
    });
    if (blocked) {
      const error = new Error(blocked.error);
      error.code = blocked.errorCode;
      error.status = 409;
      error.body = blocked;
      throw error;
    }

    const signal = options.signal
      || (typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined);

    const response = await gatedFetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...getOpenCodeAuthHeaders(),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (body && body.errorCode === 'RUNTIME_CONTRACT_EXECUTION_BLOCKED') {
        const error = new Error(body.error || 'OpenCode runtime contract blocked execution');
        error.code = body.errorCode;
        error.status = response.status;
        error.body = body;
        throw error;
      }
      const error = new Error(`OpenCode ${method} ${fetchPath} failed with ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return response.json().catch(() => null);
  };

  return serverOpenCodeFetch;
}
