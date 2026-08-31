// Private relay service: config persistence, lifecycle of the relay host
// client, and the /api/openchamber/relay/* management routes.
//
// Config lives in the server settings file as `settings.privateRelay =
// { enabled, relayUrl }` (same storage precedent as tunnels/notifications).
// Routes are registered with the other OpenChamber feature routes, before the
// generic OpenCode proxy, and are covered by the same global UI auth gate.
//
// Host gate: only the Electron desktop runtime or an SSH-managed remote server
// may run a relay host (OPENCHAMBER_RUNTIME=desktop | ssh-remote).
// Plain `node server`, `dev:web:hmr`, VS Code, ordinary CLI, and browser clients
// must never open the host-control socket, mint a relay identity, advertise a
// host pairing candidate, or probe the relay. They may still be relay *clients*
// when connecting to another host.

import express from 'express';

import { createRelayIdentityRuntime } from './identity.js';
import { startRelayHost } from './host-client.js';

export const DEFAULT_RELAY_URL = 'wss://relay.openchamber.dev/ws';

export const RELAY_HOST_DESKTOP_ONLY_MESSAGE =
  'Relay host is only available in the OpenChamber desktop app or an SSH-managed remote server';

// Electron main sets this before importing the in-process web server.
export const isDesktopRelayHostRuntime = (env = process.env) =>
  env?.OPENCHAMBER_RUNTIME === 'desktop';

// Desktop app, or an SSH-manager-started remote (`OPENCHAMBER_RUNTIME=ssh-remote`).
export const isRelayHostRuntime = (env = process.env) => {
  const runtime = env?.OPENCHAMBER_RUNTIME;
  return runtime === 'desktop' || runtime === 'ssh-remote';
};

// Canonical form: ws(s)://host[:port]/path only. Reject credentials (userinfo)
// so settings and pairing candidates never store secrets in the endpoint URL.
// Strip query/fragment so persistence and candidates stay scheme/host/path.
export const canonicalizeRelayUrl = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    if (url.username || url.password) return null;
    url.username = '';
    url.password = '';
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
};

// Canonical ws(s) relay URL → Push send endpoint on the same host/port.
// Always `/v1/push/send`; never derived from window/location.
export const derivePushSendUrlFromRelayUrl = (value) => {
  const canonical = canonicalizeRelayUrl(value);
  if (!canonical) return null;
  try {
    const url = new URL(canonical);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/v1/push/send';
    url.username = '';
    url.password = '';
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
};

const normalizeRelayUrl = (value) => {
  if (typeof value !== 'string') return DEFAULT_RELAY_URL;
  return canonicalizeRelayUrl(value) ?? DEFAULT_RELAY_URL;
};

// A deployment can pin the relay endpoint via env (e.g. a self-hosted relay on
// your own Cloudflare account/domain). When set and valid it overrides the
// stored setting entirely, so the host connection, the pairing offer, and the
// status all point at it — clients then inherit it from the offer automatically.
const envRelayUrlOverride = (env = process.env) => {
  const raw = env?.OPENCHAMBER_RELAY_URL;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return canonicalizeRelayUrl(raw);
};

// Env (`OPENCHAMBER_RELAY_URL`) → settings.privateRelay.relayUrl → DEFAULT_RELAY_URL.
export const resolveEffectiveRelayUrl = ({ settings = null, env = process.env } = {}) =>
  envRelayUrlOverride(env) ?? normalizeRelayUrl(settings?.privateRelay?.relayUrl);

/**
 * @param {{
 *   crypto: typeof import('node:crypto'),
 *   readSettingsFromDiskMigrated: () => Promise<object>,
 *   writeSettingsToDisk: (settings: object) => Promise<void>,
 *   getLocalPort: () => number,
 *   logger?: Pick<Console, 'warn'>,
 *   canHostRelay?: () => boolean,
 *   onRelayUrlChanged?: () => Promise<void> | void,
 * }} deps
 */
export const createRelayService = ({
  crypto,
  readSettingsFromDiskMigrated,
  writeSettingsToDisk,
  // Strict settings reader (throws on corrupt/unreadable) gating identity
  // regeneration — see identity.js/signing-key.js.
  readSettingsStrict,
  getLocalPort,
  // Returns true when any paired device or pending pairing session uses the
  // relay transport. The relay lifecycle is driven purely by this demand.
  hasRelayDemand = async () => false,
  // Per-machine claim (host-lock.js): all local instances share the same
  // serverId, so only ONE process may run the relay host at a time or they
  // evict each other at the relay worker ("Control replaced") and devices land
  // on a random instance. Optional: without it, behavior is pre-lock.
  hostLock = null,
  // Host gate: false for non-host runtimes (dev server, ordinary CLI, VS Code, …).
  canHostRelay = () => isRelayHostRuntime(),
  logger = console,
  onRelayUrlChanged = null,
}) => {
  const identityRuntime = createRelayIdentityRuntime({ crypto, readSettingsFromDiskMigrated, writeSettingsToDisk, readSettingsStrict });

  let hostClient = null;
  let status = { state: 'disabled', lastError: null, connectedClients: 0 };
  // Re-checks the claim while enabled: a standby instance takes over when the
  // claimant dies; a running host stands down when another process claims.
  let claimWatchTimer = null;
  const CLAIM_WATCH_INTERVAL_MS = 30_000;

  const hostAllowed = () => canHostRelay() === true;

  const refuseHost = () => {
    status = {
      state: 'unavailable',
      lastError: RELAY_HOST_DESKTOP_ONLY_MESSAGE,
      connectedClients: 0,
    };
  };

  const assertHostAllowed = () => {
    if (hostAllowed()) return;
    const error = new Error(RELAY_HOST_DESKTOP_ONLY_MESSAGE);
    error.statusCode = 403;
    throw error;
  };

  const readConfig = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const stored = settings?.privateRelay;
    const override = envRelayUrlOverride();
    return {
      enabled: stored?.enabled === true,
      relayUrl: resolveEffectiveRelayUrl({ settings }),
      // True when the endpoint is pinned by OPENCHAMBER_RELAY_URL (a self-hosted
      // relay); the stored setting is ignored while it is set.
      relayUrlLocked: override !== null,
    };
  };

  const notifyRelayUrlChanged = async () => {
    if (typeof onRelayUrlChanged !== 'function') return;
    try {
      await onRelayUrlChanged();
    } catch (error) {
      logger.warn(`[Relay] push token re-register failed: ${error?.message ?? error}`);
    }
  };

  const writeConfig = async (config) => {
    const settings = await readSettingsFromDiskMigrated();
    await writeSettingsToDisk({
      ...settings,
      privateRelay: { enabled: config.enabled === true, relayUrl: normalizeRelayUrl(config.relayUrl) },
    });
  };

  const stopHostClient = () => {
    if (!hostClient) return;
    hostClient.stop();
    hostClient = null;
  };

  const standbyStatus = (holderPid) => ({
    state: 'standby',
    lastError: `relay host is owned by another local OpenChamber process (pid ${holderPid})`,
    connectedClients: 0,
  });

  // Claim watcher, active while the relay is enabled:
  //   - standby → claimant died → take over (start our host);
  //   - running → another live process claimed → stand down (stop, standby).
  // This back-off is what actually ends the mutual-eviction fight: the loser
  // must STOP reconnecting, otherwise both keep replacing each other forever.
  const ensureClaimWatch = (relayUrl) => {
    if (!hostLock || claimWatchTimer) return;
    claimWatchTimer = setInterval(() => {
      void (async () => {
        try {
          if (hostClient) {
            if (!hostLock.holdsClaim() && hostLock.liveClaimantPid() !== null) {
              logger.warn('[Relay] host claim taken by another local instance — standing down');
              const holder = hostLock.liveClaimantPid();
              stopHostClient();
              status = standbyStatus(holder);
            }
            return;
          }
          if (status.state === 'standby' && hostLock.tryClaim()) {
            logger.warn('[Relay] host claim is free — taking over the relay host');
            await start(relayUrl);
          }
        } catch (error) {
          logger.warn(`[Relay] claim watch failed: ${error?.message ?? error}`);
        }
      })();
    }, CLAIM_WATCH_INTERVAL_MS);
    if (typeof claimWatchTimer.unref === 'function') claimWatchTimer.unref();
  };

  const stopClaimWatch = () => {
    if (!claimWatchTimer) return;
    clearInterval(claimWatchTimer);
    claimWatchTimer = null;
  };

  const start = async (relayUrl, { claim = 'try' } = {}) => {
    if (!hostAllowed()) {
      refuseHost();
      return;
    }
    if (hostClient) return;
    if (hostLock) {
      const claimed = claim === 'force' ? hostLock.forceClaim() : hostLock.tryClaim();
      if (!claimed) {
        status = standbyStatus(hostLock.liveClaimantPid());
        ensureClaimWatch(relayUrl);
        return;
      }
    }
    const identity = await identityRuntime.getRelayIdentity();
    hostClient = startRelayHost({
      relayUrl,
      identity,
      getLocalPort,
      logger,
      onStatus: (next) => {
        status = next;
      },
    });
    status = hostClient.getStatus();
    ensureClaimWatch(relayUrl);
  };

  const stop = () => {
    stopClaimWatch();
    stopHostClient();
    if (hostLock) hostLock.release();
    status = { state: 'disabled', lastError: null, connectedClients: 0 };
  };

  const startIfEnabled = async () => {
    try {
      const config = await readConfig();
      if (config.enabled) {
        await start(config.relayUrl);
      }
    } catch (error) {
      logger.warn(`[Relay] startup failed: ${error?.message ?? error}`);
    }
  };

  // Drive the relay lifecycle from demand: run it when a device or pending
  // session uses the relay, stop it when none remain. Called on startup and after
  // pairing/device changes, so the operator never toggles it manually.
  // Non-host runtimes never host: skip entirely so a shared data dir with
  // Electron is not rewritten or claim-contested by dev/CLI servers.
  // SSH-managed remotes (`ssh-remote`) may also keep an explicit
  // `privateRelay.enabled` opt-in (e.g. `openchamber serve --relay-host`) even
  // when no paired device is present yet — desktop still auto-clears enabled
  // when demand drops.
  const reconcile = async () => {
    if (!hostAllowed()) {
      refuseHost();
      return;
    }
    try {
      const demand = await hasRelayDemand();
      const config = await readConfig();
      if (demand) {
        if (!config.enabled) await writeConfig({ enabled: true, relayUrl: config.relayUrl });
        if (!hostClient) {
          const next = await readConfig();
          await start(next.relayUrl);
        }
      } else if (config.enabled && !isDesktopRelayHostRuntime()) {
        // Sticky opt-in on ssh-remote (and any future non-desktop host runtime).
        if (!hostClient) await start(config.relayUrl);
      } else {
        if (config.enabled) await writeConfig({ enabled: false, relayUrl: config.relayUrl });
        stop();
      }
    } catch (error) {
      logger.warn(`[Relay] reconcile failed: ${error?.message ?? error}`);
    }
  };

  // Stable server identity (base64url SHA-256 of the canonical public signing
  // JWK). Derived from a public key, so it is not a secret; clients use it to
  // verify that a learned/probed address belongs to this server before trusting
  // it. Independent of whether the relay host is currently enabled. Off a host
  // runtime this is null — minting identity is a desktop / ssh-remote concern.
  const getServerId = async () => {
    if (!hostAllowed()) return null;
    const identity = await identityRuntime.getRelayIdentity();
    return identity.serverId;
  };

  const getStatus = async () => {
    if (!hostAllowed()) {
      return {
        enabled: false,
        hostAllowed: false,
        state: 'unavailable',
        serverId: null,
        connectedClients: 0,
        lastError: RELAY_HOST_DESKTOP_ONLY_MESSAGE,
      };
    }
    const config = await readConfig();
    const identity = await identityRuntime.getRelayIdentity();
    const live = hostClient ? hostClient.getStatus() : status;
    return {
      enabled: config.enabled,
      hostAllowed: true,
      // Without a host client the service is either off or standing by while
      // another local process owns the machine's relay host claim.
      state: hostClient ? live.state : (status.state === 'standby' ? 'standby' : 'disabled'),
      serverId: identity.serverId,
      // Public E2EE trust anchor. Desktop SSH attach uses this to persist a
      // multi-transport host (local-forward + relay) without a pairing round-trip.
      hostEncPubJwk: identity.hostEncPubJwk,
      connectedClients: live.connectedClients,
      relayUrl: config.relayUrl,
      relayUrlLocked: config.relayUrlLocked,
      ...(live.lastError ? { lastError: live.lastError } : {}),
    };
  };

  // Pairing candidate for the unified connection payload (pairing v2). Relay is
  // just another transport: it carries the relay route + E2EE trust anchor, no
  // embedded token — the client redeems the one-time pairing secret over the
  // tunnel like any other candidate. Returns null when the host relay is off, so
  // callers only advertise relay when it is actually reachable. Priority is high
  // (tried after LAN/tunnel) since the relay path is the last-resort transport.
  const buildPairingCandidate = async () => {
    const config = await readConfig();
    const identity = await identityRuntime.getRelayIdentity();
    return {
      type: 'relay',
      relayUrl: config.relayUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      priority: 30,
    };
  };

  const getPairingCandidate = async () => {
    if (!hostAllowed()) return null;
    const config = await readConfig();
    if (!config.enabled) return null;
    return buildPairingCandidate();
  };

  // Enable the relay host on demand and return its pairing candidate. Creating a
  // relay pairing link IS the demand signal, so the relay turns itself on here
  // rather than requiring a separate manual toggle. Idempotent: a no-op when the
  // relay is already enabled and running.
  const ensureEnabledForPairing = async (requestedRelayUrl) => {
    assertHostAllowed();
    const config = await readConfig();
    let relayUrl = config.relayUrl;
    if (!config.relayUrlLocked && requestedRelayUrl !== undefined) {
      const canonical = canonicalizeRelayUrl(requestedRelayUrl);
      if (!canonical) {
        const error = new Error('Relay URL must use ws:// or wss://');
        error.statusCode = 400;
        throw error;
      }
      relayUrl = canonical;
    }

    const endpointChanged = relayUrl !== config.relayUrl;
    if (!config.enabled || endpointChanged) {
      await writeConfig({ enabled: true, relayUrl });
    }
    const next = await readConfig();
    if (next.relayUrl !== config.relayUrl) {
      await notifyRelayUrlChanged();
    }
    if (endpointChanged) {
      // One Host identity can have only one live Relay control connection. A
      // custom endpoint therefore becomes the authoritative transport before
      // its pairing candidate is returned. Stop also clears a standby claim
      // watcher whose retry closure still targets the previous endpoint.
      stop();
    }
    if (!hostClient) {
      const next = await readConfig();
      // Force-claim: creating a pairing link is explicit user intent — the
      // instance the user is pairing against MUST be the one devices reach,
      // even if another local process currently holds the machine's claim
      // (its claim watcher sees the takeover and stands down).
      await start(next.relayUrl, { claim: 'force' });
    }
    return buildPairingCandidate();
  };

  const registerRoutes = (app) => {
    app.get('/api/openchamber/relay/status', async (_req, res) => {
      try {
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to read relay status' });
      }
    });

    app.post('/api/openchamber/relay/enable', express.json({ limit: '16kb' }), async (req, res) => {
      try {
        if (!hostAllowed()) {
          return res.status(403).json({ error: RELAY_HOST_DESKTOP_ONLY_MESSAGE });
        }
        const current = await readConfig();
        let relayUrl = current.relayUrl;
        if (typeof req.body?.relayUrl === 'string') {
          // Reject invalid endpoints with 400 instead of silently falling back
          // to the default (which would hide bad userinfo/scheme from the UI).
          const canonical = canonicalizeRelayUrl(req.body.relayUrl);
          if (!canonical) {
            return res.status(400).json({ error: 'Relay URL must use ws:// or wss://' });
          }
          relayUrl = canonical;
        }
        await writeConfig({ enabled: true, relayUrl });
        const next = await readConfig();
        if (next.relayUrl !== current.relayUrl) {
          await notifyRelayUrlChanged();
        }
        if (hostClient) stop();
        // Explicit user action: take the machine's host claim like pairing does.
        await start(relayUrl, { claim: 'force' });
        res.json(await getStatus());
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        res.status(statusCode).json({ error: error?.message ?? 'Failed to enable relay' });
      }
    });

    app.post('/api/openchamber/relay/disable', async (_req, res) => {
      try {
        if (!hostAllowed()) {
          return res.status(403).json({ error: RELAY_HOST_DESKTOP_ONLY_MESSAGE });
        }
        const current = await readConfig();
        await writeConfig({ enabled: false, relayUrl: current.relayUrl });
        stop();
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to disable relay' });
      }
    });

  };

  return {
    registerRoutes,
    startIfEnabled,
    reconcile,
    stop,
    getStatus,
    getServerId,
    getPairingCandidate,
    ensureEnabledForPairing,
  };
};
