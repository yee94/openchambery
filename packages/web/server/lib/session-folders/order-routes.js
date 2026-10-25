const emptySnapshot = () => ({ revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} });

export function registerSessionOrderRoutes(app, { fsPromises: fs, path, yuriDataDir, broadcastYuriEvent }) {
  const file = path.join(yuriDataDir, 'session-order.json');
  let writes = Promise.resolve();
  const read = async () => {
    try {
      const snapshot = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(snapshot?.revision) || snapshot.revision < 0
        || !snapshot.sessionOrderByScope || typeof snapshot.sessionOrderByScope !== 'object' || Array.isArray(snapshot.sessionOrderByScope)
        || !snapshot.sessionOrderActivityByScope || typeof snapshot.sessionOrderActivityByScope !== 'object' || Array.isArray(snapshot.sessionOrderActivityByScope)) {
        throw new Error('Invalid session order file');
      }
      return snapshot;
    } catch (error) {
      if (error.code === 'ENOENT') return emptySnapshot();
      throw error;
    }
  };
  app.get('/api/session-folders/order', async (_req, res) => {
    try {
      await writes;
      res.json(await read());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  app.post('/api/session-folders/order', async (req, res) => {
    const { scopeKey, order, activity, onlyIfAbsent } = req.body ?? {};
    if (typeof scopeKey !== 'string' || !scopeKey.trim() || scopeKey.length > 4096
      || !Array.isArray(order) || order.length > 10000
      || !order.every((id) => typeof id === 'string' && id.length > 0 && id.length < 512)
      || !activity || typeof activity !== 'object' || Array.isArray(activity)
      || Object.keys(activity).length > 10000
      || !Object.values(activity).every((value) => typeof value === 'number' && Number.isFinite(value))
      || (onlyIfAbsent !== undefined && typeof onlyIfAbsent !== 'boolean')) {
      return res.status(400).json({ error: 'Invalid session order' });
    }
    const write = writes.then(async () => {
      const current = await read();
      if (onlyIfAbsent && Object.hasOwn(current.sessionOrderByScope, scopeKey)) return current;
      const next = {
        revision: current.revision + 1,
        sessionOrderByScope: { ...current.sessionOrderByScope, [scopeKey]: [...new Set(order)] },
        sessionOrderActivityByScope: { ...current.sessionOrderActivityByScope, [scopeKey]: activity },
      };
      await fs.mkdir(yuriDataDir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${next.revision}`;
      try {
        await fs.writeFile(tmp, JSON.stringify(next), 'utf8');
        await fs.rename(tmp, file);
      } catch (error) {
        await fs.unlink(tmp).catch(() => {});
        throw error;
      }
      broadcastYuriEvent?.({
        type: 'yuri:session-order-changed',
        properties: { occurredAt: Date.now() },
      });
      return next;
    });
    writes = write.then(() => {}, () => {});
    try {
      res.json(await write);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
