import {
  createQuestionAutoDelegateCore,
  QUESTION_AUTO_DELEGATE_DELAY_MS,
} from './core.js';

const REQUEST_TIMEOUT_MS = 15_000;

const asTrimmedString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

const parseJsonSafe = async (response) => {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Web Host adapter: injects OpenCode upstream IO + event hub into the shared core.
 * Does not loop through Host `/api/question/*` routes (avoids claim re-entry).
 */
export function createQuestionAutoDelegateRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  sanitizeProjects,
  /** Optional: session-index / worktree inventory directories. */
  listIndexedDirectories,
  broadcastGlobalUiEvent,
  broadcastOpenChamberEvent,
  fetchImpl = fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  delayMs = QUESTION_AUTO_DELEGATE_DELAY_MS,
  now = () => Date.now(),
  createTimer = (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return { clear: () => clearTimeout(handle) };
  },
  createEpoch = () => `qad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  onUserTakeover,
} = {}) {
  const upstream = async (path, { directory, method = 'GET', body } = {}) => {
    const url = new URL(buildOpenCodeUrl(path, ''));
    if (directory) url.searchParams.set('directory', directory);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...getOpenCodeAuthHeaders(),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        uncertain: true,
        status: 0,
        body: { error: error?.message ?? 'Upstream request failed' },
      };
    }

    const parsed = await parseJsonSafe(response);
    if (response.ok) {
      return { ok: true, uncertain: false, status: response.status, body: parsed };
    }
    // Definitive client/conflict rejects — core releases claim for manual retry.
    if (response.status === 404 || response.status === 400 || response.status === 409 || response.status === 422) {
      return { ok: false, uncertain: false, status: response.status, body: parsed };
    }
    if (response.status >= 500 || response.status === 0) {
      return { ok: false, uncertain: true, status: response.status, body: parsed };
    }
    return { ok: false, uncertain: true, status: response.status, body: parsed };
  };

  const emitChanged = (tip) => {
    const event = {
      type: 'openchamber:question-auto-delegate-changed',
      properties: {
        epoch: tip.epoch,
        revision: tip.revision,
      },
    };
    try {
      broadcastOpenChamberEvent?.(event);
    } catch {
      // ignore
    }
    try {
      broadcastGlobalUiEvent?.(event);
    } catch {
      // ignore
    }
  };

  const core = createQuestionAutoDelegateCore({
    delayMs,
    io: {
      now,
      createTimer,
      createEpoch,
      onChanged: emitChanged,
      onUserTakeover,
      /**
       * @returns {Promise<boolean|null>} true/false when known; null when settings unreadable.
       */
      async readEnabled() {
        try {
          const settings = await readSettingsFromDiskMigrated();
          if (settings?.questionAutoDelegateEnabled === false) return false;
          return true;
        } catch {
          return null;
        }
      },
      async listDirectories() {
        const dirs = new Set();
        try {
          const settings = await readSettingsFromDiskMigrated();
          const projects = typeof sanitizeProjects === 'function'
            ? (sanitizeProjects(settings?.projects ?? []) || [])
            : (Array.isArray(settings?.projects) ? settings.projects : []);
          for (const project of projects) {
            const path = asTrimmedString(project?.path);
            if (path) dirs.add(path);
          }
        } catch {
          // Project list failure is not fatal when index inventory exists.
        }
        if (typeof listIndexedDirectories === 'function') {
          try {
            const indexed = await listIndexedDirectories();
            if (Array.isArray(indexed)) {
              for (const directory of indexed) {
                const path = asTrimmedString(directory);
                if (path) dirs.add(path);
              }
            }
          } catch {
            // ignore index failures — core marks partial when inventory empty+failed
          }
        }
        return Array.from(dirs);
      },
      async listQuestions(directory) {
        const result = await upstream('/question', { directory });
        if (!result.ok) return null;
        const payload = result.body;
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload?.data)) return payload.data;
        return null;
      },
      async getSession(sessionID, directory) {
        const result = await upstream(`/session/${encodeURIComponent(sessionID)}`, { directory });
        if (!result.ok) return null;
        const info = result.body?.data && typeof result.body.data === 'object'
          ? result.body.data
          : result.body;
        if (!info || typeof info !== 'object') return null;
        return {
          id: asTrimmedString(info.id) || sessionID,
          parentID: asTrimmedString(info.parentID) || null,
          directory: asTrimmedString(info.directory) || asTrimmedString(directory) || null,
        };
      },
      async postReply(requestID, directory, answers) {
        return upstream(`/question/${encodeURIComponent(requestID)}/reply`, {
          directory,
          method: 'POST',
          body: { answers },
        });
      },
      async postReject(requestID, directory, body) {
        return upstream(`/question/${encodeURIComponent(requestID)}/reject`, {
          directory,
          method: 'POST',
          body: body && typeof body === 'object' ? body : {},
        });
      },
    },
  });

  const processHubEvent = (event) => {
    const raw = event?.payload;
    const payload = raw?.payload && typeof raw.payload === 'object' ? raw.payload : raw;
    const directory = typeof event?.directory === 'string' && event.directory && event.directory !== 'global'
      ? event.directory
      : '';
    if (!payload || typeof payload !== 'object') return;
    core.processEvent(payload, directory);
  };

  const start = () => {
    const unsubscribers = [];
    if (globalEventHub?.subscribeEvent) {
      unsubscribers.push(globalEventHub.subscribeEvent(processHubEvent));
    }
    if (globalEventHub?.subscribeStatus) {
      unsubscribers.push(globalEventHub.subscribeStatus((status) => {
        if (status?.type === 'connect') {
          void core.reconcile();
        }
      }));
    }
    const stopCore = core.start();
    const stop = () => {
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe?.();
        } catch {
          // ignore
        }
      }
      stopCore?.();
      core.dispose();
    };
    core._attachStop?.(stop);
    return stop;
  };

  return {
    start,
    dispose: () => core.dispose(),
    snapshot: () => core.snapshot(),
    applyEnabled: (enabled) => core.applyEnabled(enabled),
    pause: (input) => core.pause(input),
    delegate: (input) => core.delegate(input),
    submit: (input) => core.submit(input),
    reconcile: (options) => core.reconcile(options),
    processEvent: (payload, directory) => core.processEvent(payload, directory),
    isBlockingSession: (sessionID) => core.isBlockingSession(sessionID),
    isAutoHandling: (sessionID, requestID) => core.isAutoHandling(sessionID, requestID),
    pauseForSessionTree: (sessionID, directory) => core.pauseForSessionTree(sessionID, directory),
    resolveRootSession: (sessionID) => core.resolveRootSession(sessionID),
  };
}
