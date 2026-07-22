const withDirectory = (session, directory) => {
  if (!session || typeof session !== 'object') return null;
  if (session.directory || session.project?.worktree || !directory || directory === 'global') return session;
  return { ...session, directory };
};

export const applySessionIndexEvent = (service, event, observedAt = Date.now()) => {
  if (!service || !event || typeof event !== 'object') return false;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : event;
  const directory = typeof event.directory === 'string' ? event.directory : '';
  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};

  if (payload.type === 'session.created' || payload.type === 'session.updated') {
    const session = withDirectory(properties.info, directory);
    return session ? service.upsertAndReportChange(session, observedAt, { preserveActivity: true }) : false;
  }

  if (payload.type === 'session.deleted') {
    const sessionID = typeof properties.sessionID === 'string'
      ? properties.sessionID
      : typeof properties.info?.id === 'string'
        ? properties.info.id
        : '';
    return sessionID ? service.remove(sessionID) : false;
  }

  if (payload.type === 'message.updated') {
    const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
    if (info.role !== 'user' || typeof info.sessionID !== 'string') return false;
    const activityAt = typeof info.time?.created === 'number' ? info.time.created : observedAt;
    return service.touchActivity(info.sessionID, activityAt);
  }

  if (payload.type === 'session.status') {
    const sessionID = typeof properties.sessionID === 'string' ? properties.sessionID : '';
    const status = typeof properties.status?.type === 'string'
      ? properties.status.type
      : typeof properties.info?.type === 'string'
        ? properties.info.type
        : '';
    return sessionID && status ? service.updateStatus(sessionID, status, observedAt) : false;
  }

  if (payload.type === 'session.idle') {
    const sessionID = typeof properties.sessionID === 'string' ? properties.sessionID : '';
    if (!sessionID) return false;
    const activityChanged = service.touchActivity(sessionID, observedAt);
    const statusChanged = service.updateStatus(sessionID, 'idle', observedAt);
    return activityChanged || statusChanged;
  }

  if (payload.type === 'session.error') {
    const sessionID = typeof properties.sessionID === 'string' ? properties.sessionID : '';
    return sessionID ? service.updateStatus(sessionID, 'idle', observedAt) : false;
  }

  return false;
};
