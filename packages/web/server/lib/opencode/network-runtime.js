import { evaluateOpenCodeHealthBody } from './opencode2-pin.js';

export const createOpenCodeNetworkRuntime = (deps) => {
  const {
    state,
    getOpenCodeAuthHeaders,
    configuredOpenCodeHostname = '127.0.0.1',
  } = deps;

  const resolveConnectHostname = () => {
    const raw = typeof configuredOpenCodeHostname === 'string' ? configuredOpenCodeHostname.trim() : '';
    const hostname = raw || '127.0.0.1';
    if (hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]') {
      return '127.0.0.1';
    }
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      return hostname;
    }
    return hostname.includes(':') ? `[${hostname}]` : hostname;
  };

  const normalizeApiPrefix = (prefix) => {
    if (!prefix) {
      return '';
    }

    if (prefix.includes('://')) {
      try {
        const parsed = new URL(prefix);
        return normalizeApiPrefix(parsed.pathname);
      } catch {
        return '';
      }
    }

    const trimmed = prefix.trim();
    if (!trimmed || trimmed === '/') {
      return '';
    }
    const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading;
  };

  const waitForReady = async (url, timeoutMs = 10000) => {
    const start = Date.now();
    const baseUrl = url.replace(/\/+$/, '');
    while (Date.now() - start < timeoutMs) {
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 3000);
        const headers = {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        };
        for (const healthPath of ['/api/info', '/global/health']) {
          const response = await fetch(`${baseUrl}${healthPath}`, {
            method: 'GET',
            headers,
            signal: controller.signal,
          });
          if (response.ok) {
            const body = await response.json().catch(() => null);
            // Official 2.x /api/info is ServerInfo (version, no healthy);
            // /global/health may still return { healthy, version }.
            if (evaluateOpenCodeHealthBody(body).ok) {
              return true;
            }
          }
        }
      } catch {
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };

  const setDetectedOpenCodeApiPrefix = () => {
    state.openCodeApiPrefix = '';
    state.openCodeApiPrefixDetected = true;
    if (state.openCodeApiDetectionTimer) {
      clearTimeout(state.openCodeApiDetectionTimer);
      state.openCodeApiDetectionTimer = null;
    }
  };

  const buildOpenCodeUrl = (path, prefixOverride) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    // v2 protocol mounts every route under `/api` (`@opencode-ai/protocol`).
    // Callers pass unprefixed API paths (`/session`, `/event`, …); the bare
    // upstream path falls through to the v2 Web UI HTML fallback. `/` stays the
    // upstream origin for SDK base URLs, and already-prefixed paths are kept.
    const apiPath = normalizedPath === '/' || normalizedPath.startsWith('/api')
      ? normalizedPath
      : `/api${normalizedPath}`;
    const prefix = normalizeApiPrefix(prefixOverride !== undefined ? prefixOverride : '');
    const fullPath = `${prefix}${apiPath}`;
    const base = state.openCodeBaseUrl ?? `http://${resolveConnectHostname()}:${state.openCodePort}`;
    return `${base}${fullPath}`;
  };

  const detectOpenCodeApiPrefix = () => {
    state.openCodeApiPrefixDetected = true;
    state.openCodeApiPrefix = '';
    return true;
  };

  const ensureOpenCodeApiPrefix = () => detectOpenCodeApiPrefix();

  const scheduleOpenCodeApiDetection = () => {
    return;
  };

  return {
    waitForReady,
    normalizeApiPrefix,
    setDetectedOpenCodeApiPrefix,
    buildOpenCodeUrl,
    ensureOpenCodeApiPrefix,
    scheduleOpenCodeApiDetection,
  };
};
