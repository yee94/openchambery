import { makeOpenCodeV2Client } from '../opencode/v2-client.js';
import { projectSessionWithHostMetadata } from '../session-metadata/session-projection.js';
import { projectSessionMessageRecords } from '../session-turn-pages/session-message-projection.js';

/** Title reads use OpenCode; title-refresh metadata and its notifications belong to the Host. */
export function createTitleSessionAccess({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSessionMetadata,
  persistSessionMetadata,
  publishSession,
}) {
  const client = () => makeOpenCodeV2Client({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    authHeaders: getOpenCodeAuthHeaders(),
  });
  const options = () => ({ signal: AbortSignal.timeout(30_000) });
  const get = async (sessionID) => {
    const session = await client().session.get({ sessionID }, options());
    return projectSessionWithHostMetadata(session, await readSessionMetadata(sessionID));
  };
  return {
    get,
    async messages(sessionID, _directory, limit) {
      const page = await client().message.list({ sessionID, limit, order: 'desc' }, options());
      if (!Array.isArray(page?.data)) throw new Error('Session title: invalid message page');
      return projectSessionMessageRecords([...page.data].reverse());
    },
    async update(sessionID, directory, patch) {
      // Never write the complete metadata snapshot back: goal/archive/ownership
      // may have changed while the title model was running.
      const refresh = patch.metadata?.openchamber?.titleRefresh;
      if (refresh) {
        await persistSessionMetadata(sessionID, { openchamber: { titleRefresh: {
          ...refresh,
        } } });
      }
      if (typeof patch.title === 'string') {
        await client().session.update({ sessionID, title: patch.title }, options());
        const session = await get(sessionID);
        await publishSession(session, directory);
        return session;
      }
    },
  };
}
