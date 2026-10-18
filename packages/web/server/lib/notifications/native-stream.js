import { randomUUID } from 'node:crypto';

// A small, process-local replay window. No transcript content or credentials are persisted.
export const createNativeNotificationStream = ({ now = Date.now, maxEntries = 128, ttlMs = 15 * 60_000 } = {}) => {
  const epoch = randomUUID();
  let sequence = 0;
  const history = [];
  const clients = new Set();
  const cursor = () => `${epoch}:${sequence}`;
  const prune = () => {
    while (history.length && (history.length > maxEntries || history[0].at < now() - ttlMs)) history.shift();
  };
  const write = (res, entry) => {
    if (res.destroyed || res.writableEnded) return;
    // Disconnect a slow consumer; its last processed cursor recovers retained events.
    if (!res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.data)}\n\n`)) res.destroy();
    else res.flush?.();
  };
  const publish = (payload) => {
    if (!payload || typeof payload.title !== 'string' || !payload.title.trim()) return;
    const data = { type: 'notification', title: payload.title.slice(0, 256), body: String(payload.body ?? '').slice(0, 1024) };
    for (const [field, limit] of Object.entries({ tag: 256, kind: 64, sessionId: 256, assistantID: 256, directory: 1024 })) {
      if (typeof payload[field] === 'string') data[field] = payload[field].slice(0, limit);
    }
    data.requireHidden = payload.requireHidden === true;
    sequence += 1;
    const entry = { id: cursor(), sequence, at: now(), data };
    history.push(entry);
    prune();
    for (const res of clients) {
      try { write(res, entry); } catch { res.destroy(); }
    }
  };
  const connect = (req, res, authorize) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    prune();
    const lastId = req.headers['last-event-id'];
    const suffix = typeof lastId === 'string' && lastId.startsWith(`${epoch}:`) ? lastId.slice(epoch.length + 1) : '';
    const lastSequence = /^\d+$/.test(suffix) ? Number(suffix) : -1;
    const known = Number.isSafeInteger(lastSequence) && lastSequence >= 0 && lastSequence <= sequence;
    // Unknown/expired cursors are an explicit gap, never a successful replay.
    const gap = Boolean(lastId && (!known || lastSequence < (history[0]?.sequence ?? sequence + 1) - 1));
    if (known) for (const entry of history) if (entry.sequence > lastSequence) write(res, entry);
    write(res, { id: cursor(), data: { type: 'ready', gap } });
    if (res.destroyed) return;
    clients.add(res);
    let checking = false;
    const heartbeat = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        if (authorize && !await authorize()) { res.destroy(); return; }
        if (res.destroyed || res.writableEnded || !res.write(': heartbeat\n\n')) res.destroy();
        else res.flush?.();
      } catch { res.destroy(); }
      finally { checking = false; }
    }, 60_000);
    heartbeat.unref?.();
    const cleanup = () => { clearInterval(heartbeat); clients.delete(res); };
    res.once('close', cleanup);
    res.once('error', cleanup);
  };
  return { publish, connect };
};
