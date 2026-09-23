import {
  extractSessionInfoFromPayload,
  isSessionLifecycleEventType,
  normalizeSessionEventType,
  resolveSessionDirectory,
} from '../session-metadata/session-projection.js';

const withDirectory = (session, directory) => {
  if (!session || typeof session !== 'object') return null;
  const resolved = resolveSessionDirectory(session);
  if (resolved) return { ...session, directory: resolved };
  if (session.directory || session.project?.worktree || !directory || directory === 'global') return session;
  return { ...session, directory };
};

/**
 * @param {object} service
 * @param {object} event
 * @param {number} [observedAt]
 * @param {object} [options]
 * @param {(session: object) => object | null | undefined} [options.projectSession]
 *   Host authority projection before index write. Returning `null` means Host
 *   not ready / unavailable — skip the index write and keep prior rows.
 * @param {(sessionID: string) => void | Promise<void>} [options.onSessionDeleted]
 * @param {() => boolean} [options.isHostReady]
 *   When false, session lifecycle upserts are skipped until metadata is ready.
 */
export const applySessionIndexEvent = (service, event, observedAt = Date.now(), options = {}) => {
  if (!service || !event || typeof event !== 'object') return false;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : event;
  const directory = typeof event.directory === 'string' ? event.directory : '';
  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const projectSession = typeof options.projectSession === 'function' ? options.projectSession : null;
  const onSessionDeleted = typeof options.onSessionDeleted === 'function' ? options.onSessionDeleted : null;
  const isHostReady = typeof options.isHostReady === 'function' ? options.isHostReady : null;

  const baseType = normalizeSessionEventType(payload.type);

  if (baseType === 'session.created' || baseType === 'session.updated') {
    // Until Host metadata is ready, do not write session lifecycle into the
    // index (would bake unprojected upstream archive). Transcript paths use
    // message.* and stay open.
    if (isHostReady && !isHostReady()) return false;

    let session = withDirectory(extractSessionInfoFromPayload(payload), directory);
    if (!session) return false;

    if (projectSession) {
      try {
        const projected = projectSession(session);
        // null/undefined from projector = Host unavailable — keep old index data.
        if (projected == null) return false;
        session = projected;
      } catch (error) {
        console.warn('[session-index] projectSession failed; keeping prior index rows:', error?.message ?? error);
        return false;
      }
    }
    return service.upsertAndReportChange(session, observedAt, { preserveActivity: true });
  }

  if (baseType === 'session.deleted') {
    const sessionID = typeof properties.sessionID === 'string'
      ? properties.sessionID
      : typeof properties.info?.id === 'string'
        ? properties.info.id
        : typeof payload.data?.sessionID === 'string'
          ? payload.data.sessionID
          : typeof payload.data?.info?.id === 'string'
            ? payload.data.info.id
            : '';
    if (!sessionID) return false;
    const removed = service.remove(sessionID);
    if (onSessionDeleted) {
      try {
        const result = onSessionDeleted(sessionID);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => {
            console.warn('[session-index] onSessionDeleted failed (retryable):', error?.message ?? error);
          });
        }
      } catch (error) {
        console.warn('[session-index] onSessionDeleted failed (retryable):', error?.message ?? error);
      }
    }
    return removed;
  }

  if (baseType === 'message.updated' || payload.type === 'message.updated') {
    const info = properties.info && typeof properties.info === 'object'
      ? properties.info
      : (payload.data?.info && typeof payload.data.info === 'object' ? payload.data.info : {});
    if (info.role !== 'user' || typeof info.sessionID !== 'string') return false;
    const activityAt = typeof info.time?.created === 'number' ? info.time.created : observedAt;
    return service.touchActivity(info.sessionID, activityAt);
  }

  if (baseType === 'session.status') {
    const sessionID = typeof properties.sessionID === 'string'
      ? properties.sessionID
      : (typeof payload.data?.sessionID === 'string' ? payload.data.sessionID : '');
    const status = typeof properties.status?.type === 'string'
      ? properties.status.type
      : typeof properties.info?.type === 'string'
        ? properties.info.type
        : (typeof payload.data?.status?.type === 'string' ? payload.data.status.type : '');
    return sessionID && status ? service.updateStatus(sessionID, status, observedAt) : false;
  }

  if (baseType === 'session.idle') {
    const sessionID = typeof properties.sessionID === 'string'
      ? properties.sessionID
      : (typeof payload.data?.sessionID === 'string' ? payload.data.sessionID : '');
    if (!sessionID) return false;
    const activityChanged = service.touchActivity(sessionID, observedAt);
    const statusChanged = service.updateStatus(sessionID, 'idle', observedAt);
    return activityChanged || statusChanged;
  }

  if (baseType === 'session.error') {
    const sessionID = typeof properties.sessionID === 'string'
      ? properties.sessionID
      : (typeof payload.data?.sessionID === 'string' ? payload.data.sessionID : '');
    return sessionID ? service.updateStatus(sessionID, 'idle', observedAt) : false;
  }

  // Unknown lifecycle variants with version suffixes already normalized above.
  if (isSessionLifecycleEventType(payload.type)) return false;

  return false;
};
