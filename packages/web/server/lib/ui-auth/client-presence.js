/** Authenticated open SSE responses, scoped to one host's auth controller. */
export const createClientPresence = () => {
  const responses = new Map();
  const track = (req, auth) => {
    const res = req.res;
    const raw = auth?.client?.id || auth?.clientId || auth?.sessionToken;
    const id = typeof raw === 'string' && raw.startsWith('client:') ? raw.slice(7) : auth?.client?.id || auth?.clientId;
    if (!id || !res || res.destroyed || res.writableEnded || responses.has(res)) return;
    responses.set(res, id);
    const cleanup = () => {
      responses.delete(res);
      res.off('close', cleanup);
      res.off('finish', cleanup);
    };
    res.once('close', cleanup);
    res.once('finish', cleanup);
  };
  const connectedIds = () => new Set([...responses].filter(([res]) => (
    !res.destroyed && !res.writableEnded
    && String(res.getHeader('content-type') || '').toLowerCase().startsWith('text/event-stream')
  )).map(([, id]) => id));
  return { track, connectedIds };
};
