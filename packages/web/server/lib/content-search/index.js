import path from 'node:path';
import { makeOpenCodeV2Client } from '../opencode/v2-client.js';
import { createContentSearchService } from './service.js';
import { createContentSearchRuntime } from './runtime.js';

export function createGlobalContentSearch({ dataDir, getRuntimeKey, getEventRuntimeKey, buildOpenCodeUrl, getOpenCodeAuthHeaders, waitForReady }) {
  const service = createContentSearchService({ dbPath: path.join(dataDir, 'content-search.sqlite') });
  const client = () => makeOpenCodeV2Client({ baseUrl: buildOpenCodeUrl('/', ''), authHeaders: getOpenCodeAuthHeaders() });
  const runtime = createContentSearchRuntime({ service, getRuntimeKey, getEventRuntimeKey,
    getSession: ({ sessionID, signal }) => client().session.get({ sessionID }, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }),
    listSessions: async ({ signal, ...query }) => {
      await waitForReady();
      return client().session.list(query, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    },
    listMessages: ({ signal, ...query }) => client().message.list(query, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }),
  });
  runtime.start();
  return { service, runtime, getRuntimeKey, async close() { await runtime.stop(); service.close(); } };
}
