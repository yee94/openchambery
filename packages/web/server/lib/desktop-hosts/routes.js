// Desktop SSH host listing + short-lived token mint for mobile-over-relay.
// Protected by the global /api UI auth gate (registerAuthAndAccessRoutes).
// Never returns clientToken from the list endpoint; token is only issued via
// POST /ssh-host-token for SSH instance hosts that already store one.

/**
 * @param {import('express').Express} app
 * @param {{
 *   readSettingsFromDiskMigrated: () => Promise<object>,
 *   getSshRoutingTable?: () => { id: string, localPort: number }[],
 *   getPairingSession?: (id: string) => Promise<{ id: string, sshHostId?: string | null, usedAt?: string | null } | null>,
 *   express?: typeof import('express'),
 *   logger?: Pick<Console, 'warn' | 'error'>,
 * }} deps
 */
export const registerDesktopHostRoutes = (app, deps) => {
  const {
    readSettingsFromDiskMigrated,
    getSshRoutingTable = () => [],
    getPairingSession,
    express,
    logger = console,
  } = deps;

  const readSshInstanceIds = (settings) => {
    const instances = Array.isArray(settings?.desktopSshInstances) ? settings.desktopSshInstances : [];
    const ids = new Set();
    for (const entry of instances) {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (id) ids.add(id);
    }
    return ids;
  };

  const routingPortById = () => {
    const table = typeof getSshRoutingTable === 'function' ? getSshRoutingTable() : [];
    /** @type {Map<string, number>} */
    const map = new Map();
    if (!Array.isArray(table)) return map;
    for (const entry of table) {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      const localPort = Number(entry?.localPort);
      if (!id || !Number.isFinite(localPort)) continue;
      map.set(id, localPort);
    }
    return map;
  };

  app.get('/api/openchamber/desktop-hosts', async (_req, res) => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      const sshIds = readSshInstanceIds(settings);
      const instances = Array.isArray(settings?.desktopSshInstances) ? settings.desktopSshInstances : [];
      const hostsRaw = Array.isArray(settings?.desktopHosts) ? settings.desktopHosts : [];
      /** @type {Map<string, { label?: string }>} */
      const hostById = new Map();
      for (const entry of hostsRaw) {
        const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
        if (id) hostById.set(id, entry);
      }
      const livePorts = routingPortById();

      const hosts = [];
      for (const instance of instances) {
        const id = typeof instance?.id === 'string' ? instance.id.trim() : '';
        if (!id || !sshIds.has(id)) continue;
        const stored = hostById.get(id);
        const nickname = typeof instance?.nickname === 'string' ? instance.nickname.trim() : '';
        const labelFromHost = typeof stored?.label === 'string' ? stored.label.trim() : '';
        const label = labelFromHost || nickname || id;
        const livePort = livePorts.get(id);
        const preferred = Number(instance?.localForward?.preferredLocalPort);
        const localPort = Number.isFinite(livePort)
          ? livePort
          : (Number.isFinite(preferred) ? preferred : 0);
        hosts.push({
          id,
          label,
          localPort,
          reachable: Number.isFinite(livePort),
        });
      }

      res.json({ hosts });
    } catch (error) {
      console.error('Failed to list desktop hosts:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list desktop hosts',
      });
    }
  });

  const jsonParser = express && typeof express.json === 'function'
    ? express.json({ limit: '16kb' })
    : (_req, _res, next) => next();

  app.post('/api/openchamber/ssh-host-token', jsonParser, async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const hostId = typeof req.body?.hostId === 'string' ? req.body.hostId.trim() : '';
      if (!hostId) {
        return res.status(404).json({ error: 'host_not_found' });
      }

      const settings = await readSettingsFromDiskMigrated();
      const sshIds = readSshInstanceIds(settings);
      if (!sshIds.has(hostId)) {
        return res.status(404).json({ error: 'host_not_found' });
      }

      const pairingId = typeof req.body?.pairingId === 'string' ? req.body.pairingId.trim() : '';
      if (pairingId) {
        // Bound mint: pairing must exist, target this host, and already be redeemed.
        // Redeem itself still issues the desktop token; this gate only authorizes
        // reading the SSH instance's stored clientToken.
        const session = typeof getPairingSession === 'function'
          ? await getPairingSession(pairingId)
          : null;
        const sessionHostId = typeof session?.sshHostId === 'string' ? session.sshHostId.trim() : '';
        const redeemed = Boolean(session?.usedAt);
        if (!session || sessionHostId !== hostId || !redeemed) {
          return res.status(403).json({ error: 'pairing-mismatch' });
        }
      } else {
        // Legacy unscoped mint — any authenticated bearer. Remove next cycle.
        logger.warn?.(
          '[desktop-hosts] POST /api/openchamber/ssh-host-token without pairingId is deprecated; bind mint to a redeemed pairing session',
        );
      }

      const hostsRaw = Array.isArray(settings?.desktopHosts) ? settings.desktopHosts : [];
      const host = hostsRaw.find((entry) => typeof entry?.id === 'string' && entry.id.trim() === hostId);
      const token = typeof host?.clientToken === 'string' ? host.clientToken.trim() : '';
      if (!token) {
        return res.status(404).json({ error: 'host_not_found' });
      }

      const livePort = routingPortById().get(hostId);
      const reachable = Number.isFinite(livePort);
      res.json({
        token,
        localPort: reachable ? livePort : null,
        reachable,
      });
    } catch (error) {
      logger.error?.('Failed to issue ssh host token:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to issue ssh host token',
      });
    }
  });
};
