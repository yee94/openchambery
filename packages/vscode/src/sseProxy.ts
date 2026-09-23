import type { OpenCodeManager } from './opencode';
import { waitForApiUrl } from './opencode-ready';
import { registerHostSseEmitter } from './host-sse-fanout';
import {
  createReasoningOutboundFilter,
  createSseBlockSplitter,
  filterSseBlock,
  readIncludeReasoningFromUrl,
  stripIncludeReasoningParam,
  type ReasoningOutboundFilter,
} from './reasoning-projection';
import {
  ensureSessionMetadataReadyForOutboundSse,
  projectOutboundSessionLifecycleEvent,
  type SessionMetadataReadyResult,
} from './session-metadata-runtime';

type OpenSseProxyOptions = {
  manager: OpenCodeManager;
  path: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  onChunk: (chunk: string) => void;
};

type MetadataReadyWait = (options: {
  timeoutMs?: number;
  signal?: AbortSignal;
}) => Promise<SessionMetadataReadyResult>;

/** Default: Host store gate. Tests may replace without mocking the whole module. */
let metadataReadyWaitForSse: MetadataReadyWait = ensureSessionMetadataReadyForOutboundSse;

/** Test seam: inject readiness wait (restore with `null`). */
export const __setSseMetadataReadyWaitForTests = (fn: MetadataReadyWait | null): void => {
  metadataReadyWaitForSse = fn ?? ensureSessionMetadataReadyForOutboundSse;
};

const SSE_METADATA_READY_TIMEOUT_MS = 12_000;

type OpenSseProxyResult = {
  headers: Record<string, string>;
  run: Promise<void>;
};

const SSE_RESPONSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
} as const;

// SSE reconnect configuration
const MAX_RECONNECTS = 3;
const BASE_RECONNECT_DELAY = 1000; // 1 second

/**
 * When includeReasoning=false drops every upstream block (long pure-reasoning
 * turns), the webview SSE client still needs activity within its 30s idle
 * timeout. Match the Web Host SSE comment heartbeat cadence.
 */
const FILTERED_SSE_HEARTBEAT_INTERVAL_MS = 10_000;
const FILTERED_SSE_HEARTBEAT_CHUNK = ':heartbeat\n\n';

type OutboundSseFilter = {
  projectEvent: (payload: unknown) => unknown | null;
  dispose?: () => void;
};

/**
 * Compose reasoning strip + Host session archive projection.
 * Session lifecycle overlay always runs when present so upstream session.updated
 * cannot wipe Host `time.archived` authority.
 */
const composeOutboundSseFilters = (
  ...filters: Array<OutboundSseFilter | null | undefined>
): OutboundSseFilter | null => {
  const active = filters.filter((filter): filter is OutboundSseFilter => Boolean(filter));
  if (active.length === 0) return null;
  if (active.length === 1) return active[0];
  return {
    projectEvent: (payload) => {
      let current: unknown = payload;
      for (const filter of active) {
        current = filter.projectEvent(current);
        if (current == null) return null;
      }
      return current;
    },
    dispose: () => {
      for (const filter of active) filter.dispose?.();
    },
  };
};

const createHostSessionSseFilter = (): OutboundSseFilter => ({
  projectEvent: (payload) => projectOutboundSessionLifecycleEvent(payload),
});

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }

  const timeout = setTimeout(() => {
    signal.removeEventListener('abort', handleAbort);
    resolve();
  }, ms);
  const handleAbort = () => {
    clearTimeout(timeout);
    resolve();
  };
  signal.addEventListener('abort', handleAbort, { once: true });
});

const getAbortReason = (signal: AbortSignal) => signal.reason ?? new DOMException('Aborted', 'AbortError');

type OpenCodeSsePathname = '/api/event' | '/api/global/event';

/**
 * Normalize webview SSE paths onto v2 `/api/*` roots. Accept legacy `/event`
 * forms and restore the `/api` prefix before joining the sidecar origin.
 */
const normalizeSsePath = (path: string): { pathname: OpenCodeSsePathname; searchParams: URLSearchParams; directory: string | null } => {
  const parsed = new URL(path, 'https://openchamber.invalid');
  const raw = parsed.pathname.replace(/\/+$/, '') || '/';
  const pathname: OpenCodeSsePathname =
    raw === '/api/global/event' || raw === '/global/event'
      ? '/api/global/event'
      : '/api/event';
  const directory = parsed.searchParams.get('directory');
  return {
    pathname,
    searchParams: new URLSearchParams(parsed.searchParams),
    directory: typeof directory === 'string' && directory.trim().length > 0 ? directory.trim() : null,
  };
};

const resolveDefaultDirectory = (manager: OpenCodeManager): string => {
  return manager.getWorkingDirectory() || 'global';
};

const createSseUrl = (baseUrl: string, pathname: OpenCodeSsePathname, searchParams: URLSearchParams, directory: string): URL => {
  const base = `${baseUrl.replace(/\/+$/, '')}/`;
  const url = new URL(pathname.replace(/^\/+/, ''), base);
  for (const [key, value] of searchParams) {
    // OpenChamber-only projection control — never forward to OpenCode.
    if (key === 'includeReasoning') continue;
    url.searchParams.append(key, value);
  }
  if (pathname === '/api/event' && !url.searchParams.has('directory')) {
    url.searchParams.set('directory', directory);
  }
  return url;
};

const createSseHeaders = (manager: OpenCodeManager, headers?: Record<string, string>): Record<string, string> => ({
  Accept: 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  ...(headers || {}),
  ...manager.getOpenCodeAuthHeaders(),
});

const createSseResponseHeaders = (response: Response): Record<string, string> => ({
  'content-type': response.headers.get('content-type') || SSE_RESPONSE_HEADERS['content-type'],
  'cache-control': response.headers.get('cache-control') || SSE_RESPONSE_HEADERS['cache-control'],
});

const fetchSseResponse = async (
  manager: OpenCodeManager,
  path: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<Response> => {
  const baseUrl = await waitForApiUrl(manager);
  if (!baseUrl) {
    throw new Error('OpenCode API URL not available');
  }

  // Strip OpenChamber-only includeReasoning before upstream OpenCode fetch.
  const upstreamPath = stripIncludeReasoningParam(path);
  const { pathname, searchParams, directory } = normalizeSsePath(upstreamPath);
  const resolvedDirectory = directory || resolveDefaultDirectory(manager);
  const targetUrl = createSseUrl(baseUrl, pathname, searchParams, resolvedDirectory);

  const response = await fetch(targetUrl.toString(), {
    method: 'GET',
    headers: createSseHeaders(manager, headers),
    signal,
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const error = new Error(`OpenCode SSE request failed (${response.status})`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  if (!response.body) {
    throw new Error('OpenCode SSE response missing body');
  }

  return response;
};

const pipeSseResponse = async (
  response: Response,
  signal: AbortSignal,
  onChunk: (chunk: string) => void,
  outboundFilter: OutboundSseFilter | null,
  /** Heartbeat only when reasoning strip can drop long pure-reasoning stretches. */
  enableFilteredHeartbeat: boolean,
): Promise<void> => {
  if (!response.body) {
    throw new Error('OpenCode SSE response missing body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const splitter = outboundFilter ? createSseBlockSplitter() : null;

  // Filtered-only keepalive: last real downstream emission timestamp.
  let lastDownstreamEmissionMs = Date.now();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const emitDownstream = (chunk: string) => {
    if (!chunk || signal.aborted) return;
    lastDownstreamEmissionMs = Date.now();
    onChunk(chunk);
  };

  const clearHeartbeat = () => {
    if (heartbeatTimer != null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  if (enableFilteredHeartbeat && outboundFilter) {
    heartbeatTimer = setInterval(() => {
      if (signal.aborted) {
        clearHeartbeat();
        return;
      }
      if (Date.now() - lastDownstreamEmissionMs >= FILTERED_SSE_HEARTBEAT_INTERVAL_MS) {
        // Comment frame — SDK treats pure comments as activity; no reasoning body.
        emitDownstream(FILTERED_SSE_HEARTBEAT_CHUNK);
      }
    }, FILTERED_SSE_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  }

  const cancelReader = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal.aborted) {
    cancelReader();
  } else {
    signal.addEventListener('abort', cancelReader, { once: true });
  }

  const emitFilteredBlocks = (blocks: string[]) => {
    if (!outboundFilter) return;
    for (const block of blocks) {
      const filtered = filterSseBlock(block, outboundFilter);
      if (filtered && filtered.length > 0) {
        emitDownstream(filtered);
      }
    }
  };

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.length > 0) {
        if (outboundFilter && splitter) {
          // Host projection path: parse SSE blocks, apply filters, re-serialize.
          emitFilteredBlocks(splitter.push(value));
        } else {
          // No Host filters: byte-identical passthrough (no synthetic heartbeat).
          const chunk = decoder.decode(value, { stream: true });
          if (chunk.length > 0) {
            onChunk(chunk);
          }
        }
      }
    }

    if (outboundFilter && splitter) {
      emitFilteredBlocks(splitter.finish());
    } else {
      const remaining = decoder.decode();
      if (!signal.aborted && remaining.length > 0) {
        onChunk(remaining);
      }
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    clearHeartbeat();
    try {
      await reader.cancel();
    } catch {
      // ignore cancel failures during stream shutdown
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore release failures after reader shutdown
    }
  }
};

export const openSseProxy = async ({
  manager,
  path,
  headers,
  signal,
  onChunk,
}: OpenSseProxyOptions): Promise<OpenSseProxyResult> => {
  // Reconnect logic with exponential backoff
  let reconnectAttempts = 0;

  // Per openSseProxy lifecycle: includeReasoning from webview URL query.
  // Default (missing/other) keeps full stream; only strict 'false' filters.
  const includeReasoning = readIncludeReasoningFromUrl(path);
  const reasoningFilter: ReasoningOutboundFilter | null = includeReasoning
    ? null
    : createReasoningOutboundFilter();
  // Host archive authority always overlays session.created / session.updated.
  const hostSessionFilter = createHostSessionSseFilter();
  const outboundFilter = composeOutboundSseFilters(reasoningFilter, hostSessionFilter);
  const unregisterEmitter = registerHostSseEmitter(onChunk);

  const connect = async (): Promise<Response> => {
    try {
      if (signal.aborted) {
        throw getAbortReason(signal);
      }

      const { pathname } = normalizeSsePath(stripIncludeReasoningParam(path));
      console.log(`[SSE] Connecting to ${pathname} (attempt ${reconnectAttempts + 1}/${MAX_RECONNECTS + 1})`);

      // Webview SSE is independent of the extension global watcher. Gate Host
      // metadata readiness on every connect/reconnect so lifecycle frames are not
      // dropped while the committed snapshot is still unknown.
      const ready = await metadataReadyWaitForSse({
        timeoutMs: SSE_METADATA_READY_TIMEOUT_MS,
        signal,
      });
      if (signal.aborted) {
        throw getAbortReason(signal);
      }
      if (!ready.ok) {
        if (ready.error === 'aborted') {
          throw getAbortReason(signal);
        }
        // Runtime switch / stop during wait — treat as abort, do not retry as fetch.
        if (ready.error === 'session metadata runtime switched') {
          throw getAbortReason(signal);
        }
        const error = new Error(ready.error || 'session metadata not ready') as Error & {
          code?: string;
          retryable?: boolean;
        };
        error.code = 'session_metadata_unavailable';
        error.retryable = ready.retryable === true;
        throw error;
      }

      // Late cancel after readiness: never open upstream for a disposed stream.
      if (signal.aborted) {
        throw getAbortReason(signal);
      }

      const result = await fetchSseResponse(manager, path, headers, signal);
      reconnectAttempts = 0;
      return result;
    } catch (error) {
      if ((error as Error)?.name === 'AbortError' || signal.aborted) {
        throw error;
      }

      // Implement reconnect logic (includes Host readiness failure — controlled retry).
      if (!signal.aborted && reconnectAttempts < MAX_RECONNECTS) {
        reconnectAttempts++;
        const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1); // Exponential backoff

        console.warn(
          `[SSE] Connection failed (attempt ${reconnectAttempts}/${MAX_RECONNECTS}), ` +
          `retrying in ${delay}ms...`,
          error
        );

        await sleep(delay, signal);
        if (signal.aborted) {
          throw getAbortReason(signal);
        }
        return connect(); // Recursive retry
      }

      console.error(`[SSE] Connection failed after ${reconnectAttempts} attempts`, error);
      throw error;
    }
  };

  const response = await connect();

  const run = (async () => {
    let activeResponse = response;
    try {
      await pipeSseResponse(
        activeResponse,
        signal,
        onChunk,
        outboundFilter,
        Boolean(reasoningFilter),
      );
    } catch (error: unknown) {
      const cause = (error as { cause?: { code?: string } } | null)?.cause;

      // Attempt reconnect on socket errors
      if (!signal.aborted) {
        if (cause?.code === 'UND_ERR_SOCKET' || cause?.code === 'ECONNRESET') {
          console.warn('[SSE] Socket error detected, attempting reconnect...');

          if (reconnectAttempts < MAX_RECONNECTS) {
            reconnectAttempts++;
            const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
            await sleep(delay, signal);
            if (signal.aborted) {
              return;
            }

            // Attempt to reconnect
            try {
              activeResponse = await connect();
              await pipeSseResponse(
                activeResponse,
                signal,
                onChunk,
                outboundFilter,
                Boolean(reasoningFilter),
              );
              return; // Successfully reconnected
            } catch (reconnectError) {
              console.error('[SSE] Reconnect failed', reconnectError);
            }
          }
        }

        // Re-throw if we couldn't recover
        throw error;
      }
    } finally {
      unregisterEmitter();
      outboundFilter?.dispose?.();
    }
  })();

  return {
    headers: createSseResponseHeaders(response),
    run,
  };
};
