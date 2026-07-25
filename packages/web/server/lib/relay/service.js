// Private relay service: config persistence, lifecycle of the relay host
// client, and the /api/openchamber/relay/* management routes.
//
// Config lives in the server settings file as `settings.privateRelay =
// { enabled, relayUrl, transport?, accessToken?, classicRelayUrl? }` (same
// storage precedent as tunnels/notifications). When transport is `hapi`, L1
// points at a HAPI Hub endpoint and accessToken is required for host + pairing
// clients. classicRelayUrl preserves the pre-HAPI classic endpoint so switching
// back to Anywhere/relay can restore it.
// Routes are registered with the other OpenChamber feature routes, before the
// generic OpenCode proxy, and are covered by the same global UI auth gate.
//
// Cross-runtime parity note: relay host mode intentionally targets the web
// server runtime only in v1 (Electron shares this server in-process). The VS
// Code runtime does not host a relay; shared UI must treat these routes as
// web-runtime capabilities.

import express from 'express';

import { createRelayIdentityRuntime } from './identity.js';
import { startRelayHost } from './host-client.js';

export const DEFAULT_RELAY_URL = 'wss://relay.openchamber.dev/ws';

// How long `/relay/enable` waits for host-control to reach `connected` when
// configuring HAPI. Injectable via deps for unit tests.
export const DEFAULT_HAPI_CONNECT_WAIT_MS = 7_000;
const HAPI_CONNECT_POLL_MS = 100;

const isValidRelayUrl = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
};

const normalizeRelayUrl = (value) => {
  if (typeof value !== 'string') return DEFAULT_RELAY_URL;
  const trimmed = value.trim();
  if (!trimmed || !isValidRelayUrl(trimmed)) return DEFAULT_RELAY_URL;
  return trimmed;
};

// A deployment can pin the relay endpoint via env (e.g. a self-hosted relay on
// your own Cloudflare account/domain). When set and valid it overrides the
// stored setting entirely, so the host connection, the pairing offer, and the
// status all point at it — clients then inherit it from the offer automatically.
const envRelayUrlOverride = () => {
  const raw = process.env.OPENCHAMBER_RELAY_URL;
  if (typeof raw !== 'string' || !raw.trim() || !isValidRelayUrl(raw)) return null;
  return raw.trim();
};

const normalizeTransport = (value) => (value === 'hapi' ? 'hapi' : undefined);

const normalizeAccessToken = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const normalizeClassicRelayUrl = (value) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || !isValidRelayUrl(trimmed)) return undefined;
  return trimmed;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   crypto: typeof import('node:crypto'),
 *   readSettingsFromDiskMigrated: () => Promise<object>,
 *   writeSettingsToDisk: (settings: object) => Promise<void>,
 *   getLocalPort: () => number,
 *   logger?: Pick<Console, 'warn'>,
 *   hapiConnectWaitMs?: number,
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
  logger = console,
  hapiConnectWaitMs = DEFAULT_HAPI_CONNECT_WAIT_MS,
}) => {
  const identityRuntime = createRelayIdentityRuntime({ crypto, readSettingsFromDiskMigrated, writeSettingsToDisk, readSettingsStrict });

  let hostClient = null;
  let status = { state: 'disabled', lastError: null, connectedClients: 0 };
  // Re-checks the claim while enabled: a standby instance takes over when the
  // claimant dies; a running host stands down when another process claims.
  let claimWatchTimer = null;
  const CLAIM_WATCH_INTERVAL_MS = 30_000;

  const readConfig = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const stored = settings?.privateRelay;
    const override = envRelayUrlOverride();
    const transport = normalizeTransport(stored?.transport);
    // Token is only meaningful for HAPI; classic must never carry a leftover.
    const accessToken = transport === 'hapi' ? normalizeAccessToken(stored?.accessToken) : undefined;
    const classicRelayUrl = normalizeClassicRelayUrl(stored?.classicRelayUrl);
    return {
      enabled: stored?.enabled === true,
      relayUrl: override ?? normalizeRelayUrl(stored?.relayUrl),
      // True when the endpoint is pinned by OPENCHAMBER_RELAY_URL (a self-hosted
      // relay); the stored setting is ignored while it is set.
      relayUrlLocked: override !== null,
      ...(transport ? { transport } : {}),
      ...(accessToken ? { accessToken } : {}),
      ...(classicRelayUrl ? { classicRelayUrl } : {}),
    };
  };

  const writeConfig = async (config) => {
    const settings = await readSettingsFromDiskMigrated();
    const transport = normalizeTransport(config.transport);
    // Atomic: clearing transport also drops the HAPI token so classic mode never
    // reuses a leftover secret on host dial or pairing candidates.
    const accessToken = transport === 'hapi' ? normalizeAccessToken(config.accessToken) : undefined;
    if (transport === 'hapi' && !accessToken) {
      throw new Error('HAPI relay requires a non-empty accessToken');
    }
    const classicRelayUrl = normalizeClassicRelayUrl(config.classicRelayUrl);
    await writeSettingsToDisk({
      ...settings,
      privateRelay: {
        enabled: config.enabled === true,
        relayUrl: normalizeRelayUrl(config.relayUrl),
        ...(transport ? { transport } : {}),
        ...(accessToken ? { accessToken } : {}),
        ...(classicRelayUrl ? { classicRelayUrl } : {}),
      },
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

  // Only pass accessToken to the host client when transport is HAPI — classic
  // openchamber-relay must never dial with a leftover HAPI token in the query.
  const start = async (relayUrl, { claim = 'try' } = {}) => {
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
    const config = await readConfig();
    const hapiToken = config.transport === 'hapi' ? config.accessToken : undefined;
    hostClient = startRelayHost({
      relayUrl,
      identity,
      getLocalPort,
      logger,
      ...(hapiToken ? { accessToken: hapiToken } : {}),
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
  const reconcile = async () => {
    try {
      const demand = await hasRelayDemand();
      const config = await readConfig();
      if (demand) {
        if (!config.enabled) {
          await writeConfig({
            enabled: true,
            relayUrl: config.relayUrl,
            ...(config.transport ? { transport: config.transport } : {}),
            ...(config.accessToken ? { accessToken: config.accessToken } : {}),
            ...(config.classicRelayUrl ? { classicRelayUrl: config.classicRelayUrl } : {}),
          });
        }
        if (!hostClient) {
          const next = await readConfig();
          await start(next.relayUrl);
        }
      } else {
        if (config.enabled) {
          await writeConfig({
            enabled: false,
            relayUrl: config.relayUrl,
            ...(config.transport ? { transport: config.transport } : {}),
            ...(config.accessToken ? { accessToken: config.accessToken } : {}),
            ...(config.classicRelayUrl ? { classicRelayUrl: config.classicRelayUrl } : {}),
          });
        }
        stop();
      }
    } catch (error) {
      logger.warn(`[Relay] reconcile failed: ${error?.message ?? error}`);
    }
  };

  // Stable server identity (base64url SHA-256 of the canonical public signing
  // JWK). Derived from a public key, so it is not a secret; clients use it to
  // verify that a learned/probed address belongs to this server before trusting
  // it. Independent of whether the relay host is currently enabled.
  const getServerId = async () => {
    const identity = await identityRuntime.getRelayIdentity();
    return identity.serverId;
  };

  const getStatus = async () => {
    const config = await readConfig();
    const identity = await identityRuntime.getRelayIdentity();
    const live = hostClient ? hostClient.getStatus() : status;
    return {
      enabled: config.enabled,
      // Without a host client the service is either off or standing by while
      // another local process owns the machine's relay host claim.
      state: hostClient ? live.state : (status.state === 'standby' ? 'standby' : 'disabled'),
      serverId: identity.serverId,
      connectedClients: live.connectedClients,
      relayUrl: config.relayUrl,
      relayUrlLocked: config.relayUrlLocked,
      // Transport marker + presence flag only — never echo accessToken.
      ...(config.transport ? { transport: config.transport } : {}),
      hasAccessToken: Boolean(config.accessToken),
      ...(live.lastError ? { lastError: live.lastError } : {}),
    };
  };

  // Wait until host-control reports connected, or fail with a clear error for
  // auth (401) vs timeout/DNS/unreachable. Used as the HAPI config readiness gate.
  const waitForHostConnected = async (timeoutMs = hapiConnectWaitMs) => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      const live = hostClient ? hostClient.getStatus() : status;
      if (live.state === 'connected') return live;
      const err = typeof live.lastError === 'string' ? live.lastError : '';
      if (err) {
        const lower = err.toLowerCase();
        if (
          lower.includes('401')
          || lower.includes('unauthorized')
          || lower.includes('auth')
          || lower.includes('forbidden')
          || lower.includes('403')
        ) {
          const error = new Error(err || 'HAPI relay authentication failed');
          error.code = 'HAPI_AUTH';
          throw error;
        }
      }
      if (live.state === 'standby') {
        const error = new Error(live.lastError || 'relay host is on standby');
        error.code = 'HAPI_STANDBY';
        throw error;
      }
      await sleep(HAPI_CONNECT_POLL_MS);
    }
    const live = hostClient ? hostClient.getStatus() : status;
    const detail = live.lastError || `state=${live.state}`;
    const error = new Error(`HAPI relay did not connect in time (${detail})`);
    error.code = 'HAPI_TIMEOUT';
    throw error;
  };

  // Pairing candidate for the unified connection payload (pairing v2). Relay is
  // just another transport: it carries the relay route + E2EE trust anchor, no
  // embedded token — the client redeems the one-time pairing secret over the
  // tunnel like any other candidate. Returns null when the host relay is off, so
  // callers only advertise relay when it is actually reachable. Priority is high
  // (tried after LAN/tunnel) since the relay path is the last-resort transport.
  // HAPI: include accessToken only when transport === 'hapi'.
  const buildPairingCandidate = async () => {
    const config = await readConfig();
    const identity = await identityRuntime.getRelayIdentity();
    const hapiToken = config.transport === 'hapi' ? config.accessToken : undefined;
    return {
      type: 'relay',
      relayUrl: config.relayUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      priority: 30,
      ...(config.transport ? { transport: config.transport } : {}),
      ...(hapiToken ? { accessToken: hapiToken } : {}),
    };
  };

  const getPairingCandidate = async () => {
    const config = await readConfig();
    if (!config.enabled) return null;
    return buildPairingCandidate();
  };

  // Enable the relay host on demand and return its pairing candidate. Creating a
  // relay pairing link IS the demand signal, so the relay turns itself on here
  // rather than requiring a separate manual toggle. Idempotent: a no-op when the
  // relay is already enabled and running.
  const ensureEnabledForPairing = async () => {
    const config = await readConfig();
    if (!config.enabled) {
      await writeConfig({
        enabled: true,
        relayUrl: config.relayUrl,
        ...(config.transport ? { transport: config.transport } : {}),
        ...(config.accessToken ? { accessToken: config.accessToken } : {}),
        ...(config.classicRelayUrl ? { classicRelayUrl: config.classicRelayUrl } : {}),
      });
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

  // Switch back to classic OpenChamber Private Relay: drop HAPI transport + token
  // and restore the saved classic URL (or env override / default).
  const configureClassicRelay = async ({ relayUrl, enabled = true } = {}) => {
    const current = await readConfig();
    const override = envRelayUrlOverride();
    const restored = override
      ?? (typeof relayUrl === 'string' && isValidRelayUrl(relayUrl.trim()) ? relayUrl.trim() : null)
      ?? current.classicRelayUrl
      ?? DEFAULT_RELAY_URL;
    await writeConfig({
      enabled: enabled === true,
      relayUrl: restored,
      // no transport / accessToken — classic mode
      ...(current.classicRelayUrl ? { classicRelayUrl: current.classicRelayUrl } : {}),
    });
    if (hostClient) stop();
    if (enabled) {
      await start(restored, { claim: 'force' });
    }
    return getStatus();
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
        const current = await readConfig();
        const bodyTransport = req.body?.transport;
        const transport = bodyTransport === 'hapi'
          ? 'hapi'
          : (bodyTransport === null || bodyTransport === ''
            ? undefined
            : current.transport);
        // Explicit null/empty body accessToken means "reuse stored" for HAPI;
        // omit when clearing transport (classic).
        const bodyToken = typeof req.body?.accessToken === 'string'
          ? req.body.accessToken.trim()
          : undefined;
        const accessToken = transport === 'hapi'
          ? (bodyToken || current.accessToken)
          : undefined;
        if (transport === 'hapi' && !accessToken) {
          res.status(400).json({ error: 'HAPI relay requires a non-empty accessToken' });
          return;
        }

        const requestedUrl = typeof req.body?.relayUrl === 'string' ? req.body.relayUrl.trim() : '';
        const relayUrl = requestedUrl && isValidRelayUrl(requestedUrl)
          ? normalizeRelayUrl(requestedUrl)
          : current.relayUrl;

        // When entering HAPI from classic, remember the classic URL for restore.
        // When already HAPI, keep any previously saved classicRelayUrl.
        let classicRelayUrl = current.classicRelayUrl;
        if (transport === 'hapi' && current.transport !== 'hapi') {
          const override = envRelayUrlOverride();
          if (!override && current.relayUrl && isValidRelayUrl(current.relayUrl)) {
            classicRelayUrl = current.relayUrl;
          }
        }
        // Leaving HAPI without going through configureClassicRelay still clears token.
        if (transport !== 'hapi' && current.transport === 'hapi' && !classicRelayUrl) {
          // no-op; classicRelayUrl may already be set
        }

        await writeConfig({
          enabled: true,
          relayUrl,
          ...(transport ? { transport } : {}),
          ...(accessToken ? { accessToken } : {}),
          ...(classicRelayUrl ? { classicRelayUrl } : {}),
        });
        if (hostClient) stop();
        // Explicit user action: take the machine's host claim like pairing does.
        await start(relayUrl, { claim: 'force' });

        // HAPI readiness gate: do not report success until host-control is
        // connected, so the UI never creates a pairing QR against a dead hub.
        if (transport === 'hapi') {
          try {
            await waitForHostConnected();
          } catch (error) {
            const code = error?.code;
            const message = error?.message ?? 'Failed to connect HAPI relay';
            if (code === 'HAPI_AUTH') {
              res.status(401).json({ error: message });
              return;
            }
            res.status(504).json({ error: message });
            return;
          }
        }

        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to enable relay' });
      }
    });

    app.post('/api/openchamber/relay/classic', express.json({ limit: '16kb' }), async (req, res) => {
      try {
        const relayUrl = typeof req.body?.relayUrl === 'string' ? req.body.relayUrl : undefined;
        const enabled = req.body?.enabled === false ? false : true;
        res.json(await configureClassicRelay({ relayUrl, enabled }));
      } catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to configure classic relay' });
      }
    });

    app.post('/api/openchamber/relay/disable', async (_req, res) => {
      try {
        const current = await readConfig();
        await writeConfig({
          enabled: false,
          relayUrl: current.relayUrl,
          ...(current.transport ? { transport: current.transport } : {}),
          ...(current.accessToken ? { accessToken: current.accessToken } : {}),
          ...(current.classicRelayUrl ? { classicRelayUrl: current.classicRelayUrl } : {}),
        });
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
    configureClassicRelay,
    waitForHostConnected,
  };
};
