/**
 * Recover OpenCode project instances that are still accepting HTTP traffic
 * but no longer able to run turns (MCP returns 503 empty, prompts abort
 * immediately with MessageAbortedError before process starts).
 *
 * Observed when a directory instance is poisoned while sharing the managed
 * OpenCode process with other work. POST /instance/dispose recreates a healthy
 * instance on the next request.
 */

const PROMPT_ASYNC_PATH = /\/session\/[^/]+\/prompt_async\/?$/i;
const SESSION_COMMAND_PATH = /\/session\/[^/]+\/command\/?$/i;
const SESSION_SHELL_PATH = /\/session\/[^/]+\/shell\/?$/i;

export const isDirectoryTurnAdmissionPath = (pathname) => {
  if (typeof pathname !== 'string' || !pathname) return false;
  const path = pathname.split('?')[0] || '';
  return PROMPT_ASYNC_PATH.test(path) || SESSION_COMMAND_PATH.test(path) || SESSION_SHELL_PATH.test(path);
};

export const extractDirectoryFromRequest = (req) => {
  const queryDirectory = typeof req?.query?.directory === 'string' ? req.query.directory.trim() : '';
  if (queryDirectory) return queryDirectory;

  const headerDirectory = req?.headers?.['x-opencode-directory'];
  if (typeof headerDirectory !== 'string' || !headerDirectory.trim()) return '';

  if (req?.headers?.['x-opencode-directory-encoding'] === 'uri') {
    try {
      return decodeURIComponent(headerDirectory).trim();
    } catch {
      return headerDirectory.trim();
    }
  }
  return headerDirectory.trim();
};

export const isDirectoryInstanceUnhealthyStatus = (status) => status === 503;

export const createDirectoryInstanceRecovery = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = globalThis.fetch,
  log = console,
  probeTimeoutMs = 1500,
  disposeTimeoutMs = 3000,
  now = () => Date.now(),
  // Avoid thrashing dispose while a project is legitimately cold-starting MCP.
  minDisposeIntervalMs = 10_000,
} = {}) => {
  if (typeof buildOpenCodeUrl !== 'function') {
    throw new Error('createDirectoryInstanceRecovery requires buildOpenCodeUrl');
  }
  if (typeof getOpenCodeAuthHeaders !== 'function') {
    throw new Error('createDirectoryInstanceRecovery requires getOpenCodeAuthHeaders');
  }

  const inFlight = new Map();
  const lastDisposedAt = new Map();

  const authHeaders = () => {
    try {
      return getOpenCodeAuthHeaders() || {};
    } catch {
      return {};
    }
  };

  const probeMcp = async (directory) => {
    const url = buildOpenCodeUrl(`/mcp?directory=${encodeURIComponent(directory)}`, '');
    return fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders(),
      },
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
  };

  const disposeInstance = async (directory) => {
    const url = buildOpenCodeUrl(`/instance/dispose?directory=${encodeURIComponent(directory)}`, '');
    return fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...authHeaders(),
      },
      signal: AbortSignal.timeout(disposeTimeoutMs),
    });
  };

  const ensureHealthy = async (directory) => {
    const dir = typeof directory === 'string' ? directory.trim() : '';
    if (!dir) return { recovered: false, reason: 'no-directory' };

    const existing = inFlight.get(dir);
    if (existing) return existing;

    const work = (async () => {
      try {
        const probe = await probeMcp(dir);
        if (probe.ok) return { recovered: false, reason: 'healthy' };
        if (!isDirectoryInstanceUnhealthyStatus(probe.status)) {
          return { recovered: false, reason: `probe-status-${probe.status}` };
        }

        const lastAt = lastDisposedAt.get(dir);
        if (typeof lastAt === 'number' && now() - lastAt < minDisposeIntervalMs) {
          return { recovered: false, reason: 'dispose-cooldown' };
        }

        log.warn?.(
          `[opencode] directory instance unhealthy (mcp ${probe.status}); disposing before turn admission`,
          { directory: dir },
        );
        const disposed = await disposeInstance(dir);
        lastDisposedAt.set(dir, now());
        if (!disposed.ok && disposed.status !== 200) {
          return {
            recovered: false,
            reason: `dispose-status-${disposed.status}`,
          };
        }
        return { recovered: true, reason: 'disposed-after-mcp-503' };
      } catch (error) {
        log.warn?.('[opencode] directory instance recovery failed', {
          directory: dir,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          recovered: false,
          reason: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        inFlight.delete(dir);
      }
    })();

    inFlight.set(dir, work);
    return work;
  };

  return {
    ensureHealthy,
    probeMcp,
    disposeInstance,
  };
};
