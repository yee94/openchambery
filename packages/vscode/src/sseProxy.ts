import type { OpenCodeManager } from './opencode';
import { waitForApiUrl } from './opencode-ready';
import {
  createReasoningOutboundFilter,
  createSseBlockSplitter,
  filterSseBlock,
  readIncludeReasoningFromUrl,
  stripIncludeReasoningParam,
  type ReasoningOutboundFilter,
} from './reasoning-projection';

type OpenSseProxyOptions = {
  manager: OpenCodeManager;
  path: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  onChunk: (chunk: string) => void;
};

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

const normalizeSsePath = (path: string): { pathname: '/event' | '/global/event'; searchParams: URLSearchParams; directory: string | null } => {
  const parsed = new URL(path, 'https://openchamber.invalid');
  const pathname = parsed.pathname === '/global/event' ? '/global/event' : '/event';
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

const createSseUrl = (baseUrl: string, pathname: '/event' | '/global/event', searchParams: URLSearchParams, directory: string): URL => {
  const base = `${baseUrl.replace(/\/+$/, '')}/`;
  const url = new URL(pathname.replace(/^\/+/, ''), base);
  for (const [key, value] of searchParams) {
    // OpenChamber-only projection control — never forward to OpenCode.
    if (key === 'includeReasoning') continue;
    url.searchParams.append(key, value);
  }
  if (pathname === '/event' && !url.searchParams.has('directory')) {
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
  reasoningFilter: ReasoningOutboundFilter | null,
): Promise<void> => {
  if (!response.body) {
    throw new Error('OpenCode SSE response missing body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const splitter = reasoningFilter ? createSseBlockSplitter() : null;

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

  if (reasoningFilter) {
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
    if (!reasoningFilter) return;
    for (const block of blocks) {
      const filtered = filterSseBlock(block, reasoningFilter);
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
        if (reasoningFilter && splitter) {
          // Disabled path: parse SSE blocks, drop reasoning, re-serialize.
          emitFilteredBlocks(splitter.push(value));
        } else {
          // Enabled path: byte-identical passthrough (no synthetic heartbeat).
          const chunk = decoder.decode(value, { stream: true });
          if (chunk.length > 0) {
            onChunk(chunk);
          }
        }
      }
    }

    if (reasoningFilter && splitter) {
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
  const reasoningFilter = includeReasoning
    ? null
    : createReasoningOutboundFilter();

  const connect = async (): Promise<Response> => {
    try {
      const { pathname } = normalizeSsePath(stripIncludeReasoningParam(path));
      console.log(`[SSE] Connecting to ${pathname} (attempt ${reconnectAttempts + 1}/${MAX_RECONNECTS + 1})`);

      const result = await fetchSseResponse(manager, path, headers, signal);
      reconnectAttempts = 0;
      return result;
    } catch (error) {
      if ((error as Error)?.name === 'AbortError' || signal.aborted) {
        throw error;
      }

      // Implement reconnect logic
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
      await pipeSseResponse(activeResponse, signal, onChunk, reasoningFilter);
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
              await pipeSseResponse(activeResponse, signal, onChunk, reasoningFilter);
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
      reasoningFilter?.dispose();
    }
  })();

  return {
    headers: createSseResponseHeaders(response),
    run,
  };
};
