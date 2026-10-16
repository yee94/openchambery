import { makeOpenCodeV2Client } from '../opencode/v2-client.js';
import { projectSessionWithHostMetadata, readSessionTitleAuthority } from '../session-metadata/session-projection.js';
import { randomUUID } from 'node:crypto';
import { projectSessionMessageRecords } from '../session-turn-pages/session-message-projection.js';

/** Title reads use OpenCode; title-refresh metadata and its notifications belong to the Host. */
export function createTitleSessionAccess({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSessionMetadata,
  persistSessionMetadata,
  mutateSessionMetadata,
  publishSession,
}) {
  let stopped = false;
  const client = () => makeOpenCodeV2Client({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    authHeaders: getOpenCodeAuthHeaders(),
  });
  const options = () => ({ signal: AbortSignal.timeout(30_000) });
  const get = async (sessionID) => {
    const session = await client().session.get({ sessionID }, options());
    const metadata = await readSessionMetadata(sessionID);
    return projectSessionWithHostMetadata(session, metadata);
  };
  return {
    get,
    stop() {
      stopped = true;
    },
    async messages(sessionID, _directory, limit) {
      const page = await client().message.list({ sessionID, limit, order: 'desc' }, options());
      if (!Array.isArray(page?.data)) throw new Error('Session title: invalid message page');
      return projectSessionMessageRecords([...page.data].reverse());
    },
    async update(sessionID, directory, patch) {
      if (stopped) return;
      if (typeof patch.title === 'string') {
        const result = await mutateSessionMetadata(sessionID, (metadata) => {
          const current = readSessionTitleAuthority(sessionID, metadata);
          if ((current?.revision ?? null) !== (patch.expectedTitleRevision ?? null)) return { ok: false };
          return { ok: true, patch: { openchamber: {
            titleAuthority: { sessionID, title: patch.title, revision: randomUUID(), source: 'summary' },
            titleRefresh: patch.metadata?.openchamber?.titleRefresh ?? {},
          } } };
        });
        if (!result.committed || stopped) return;
        await client().session.update({ sessionID, title: patch.title }, options());
      }
      // Never write the complete metadata snapshot back: goal/archive/ownership
      // may have changed while the title model was running.
      const refresh = patch.metadata?.openchamber?.titleRefresh;
      if (refresh && typeof patch.title !== 'string') {
        await persistSessionMetadata(sessionID, { openchamber: { titleRefresh: refresh } });
      }
      if (typeof patch.title === 'string' || (refresh && Object.hasOwn(refresh, 'isGenerating'))) {
        const session = await get(sessionID);
        await publishSession(session, directory);
        return session;
      }
    },
  };
}
