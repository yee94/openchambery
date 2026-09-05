// Private relay service: config persistence, lifecycle of the relay host
// client, and the /api/openchamber/relay/* management routes.
//
// Config lives in the server settings file as `settings.privateRelay =
// { enabled, relayUrl, extraRelayUrls }` (same storage precedent as
// tunnels/notifications). `relayUrl` is the PRIMARY endpoint (push
// registration, default pairing candidate); `extraRelayUrls` are additional
// endpoints ("multi-relay"): the host dials every configured endpoint at once
// with the SAME identity, so one server is reachable via several domains and
// clients treat serverId + relayUrl pairs as distinct instances. Routes are
// registered with the other OpenChamber feature routes, before the generic
// OpenCode proxy, and are covered by the same global UI auth gate.
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

// Additional relay endpoints ("multi-relay"): one host identity may dial
// several relays at once so the same server is reachable (and pairable) via
// multiple domains. Canonicalized, de-duplicated; the primary endpoint is
// excluded by the caller (readConfig) because it lives in its own field.
const normalizeExtraRelayUrls = (value) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const canonical = canonicalizeRelayUrl(entry);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }
  return result;
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
  // Owner gate for endpoint-management routes (`/relay/endpoints`): only a UI
  // session or the local desktop shell may add/remove relay endpoints. Optional
  // dependency; when absent the route refuses everything.
  isOwnerRequest = async (_req, _res) => false,
}) => {
  const identityRuntime = createRelayIdentityRuntime({ crypto, readSettingsFromDiskMigrated, writeSettingsToDisk, readSettingsStrict });

  // One host-control connection per relay endpoint; all share the machine's
  // single relay identity (same serverId) and one host claim.
  const hostClients = new Map();
  let status = { state: 'disabled', lastError: null, connectedClients: 0 };
  const endpointStatuses = new Map();
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
    const primary = resolveEffectiveRelayUrl({ settings });
    const extras = normalizeExtraRelayUrls(stored?.extraRelayUrls).filter((url) => url !== primary);
    return {
      enabled: stored?.enabled === true,
      relayUrl: primary,
      // Additional relay endpoints (multi-relay): the same host identity dials
      // every endpoint simultaneously, so one server is reachable via several
      // domains. The primary stays authoritative for push and default pairing.
      extraRelayUrls: extras,
      relayUrls: [primary, ...extras],
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
    const primary = normalizeRelayUrl(config.relayUrl);
    const extras = normalizeExtraRelayUrls(config.extraRelayUrls).filter((url) => url !== primary);
    await writeSettingsToDisk({
      ...settings,
      privateRelay: { enabled: config.enabled === true, relayUrl: primary, extraRelayUrls: extras },
    });
  };

  const stopHostClient = (relayUrl) => {
    const client = hostClients.get(relayUrl);
    if (!client) return;
    client.stop();
    hostClients.delete(relayUrl);
    endpointStatuses.delete(relayUrl);
  };

  const stopAllHostClients = () => {
    for (const relayUrl of Array.from(hostClients.keys())) {
      stopHostClient(relayUrl);
    }
  };

  const aggregateStatus = () => {
    if (hostClients.size === 0) return status;
    const states = Array.from(endpointStatuses.values());
    const state = states.some((entry) => entry.state === 'connected')
      ? 'connected'
      : states.some((entry) => entry.state === 'connecting') ? 'connecting' : 'error';
    const lastError = states.map((entry) => entry.lastError).find(Boolean) ?? null;
    return { state, lastError, connectedClients: states.reduce((sum, entry) => sum + entry.connectedClients, 0) };
  };

  const refreshStatusFromEndpoints = () => {
    status = aggregateStatus();
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
  const ensureClaimWatch = () => {
    if (!hostLock || claimWatchTimer) return;
    claimWatchTimer = setInterval(() => {
      void (async () => {
        try {
          if (hostClients.size > 0) {
            if (!hostLock.holdsClaim() && hostLock.liveClaimantPid() !== null) {
              logger.warn('[Relay] host claim taken by another local instance — standing down');
              const holder = hostLock.liveClaimantPid();
              stopAllHostClients();
              status = standbyStatus(holder);
            }
            return;
          }
          if (status.state === 'standby' && hostLock.tryClaim()) {
            logger.warn('[Relay] host claim is free — taking over the relay host');
            const config = await readConfig();
            await start(config.relayUrls);
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

  // `relayUrls` may be a single canonical endpoint or the full list; each
  // endpoint gets its own host-control connection (skipped when already up).
  const start = async (relayUrls, { claim = 'try' } = {}) => {
    if (!hostAllowed()) {
      refuseHost();
      return;
    }
    const endpoints = (Array.isArray(relayUrls) ? relayUrls : [relayUrls])
      .map((url) => canonicalizeRelayUrl(url))
      .filter((url, index, list) => url && list.indexOf(url) === index);
    if (endpoints.length === 0) return;
    const pending = endpoints.filter((url) => !hostClients.has(url));
    if (pending.length === 0) return;
    if (hostLock) {
      const claimed = claim === 'force' ? hostLock.forceClaim() : hostLock.tryClaim();
      if (!claimed) {
        status = standbyStatus(hostLock.liveClaimantPid());
        ensureClaimWatch();
        return;
      }
    }
    const identity = await identityRuntime.getRelayIdentity();
    for (const relayUrl of pending) {
      const hostClient = startRelayHost({
        relayUrl,
        identity,
        getLocalPort,
        logger,
        onStatus: (next) => {
          endpointStatuses.set(relayUrl, next);
          refreshStatusFromEndpoints();
        },
      });
      hostClients.set(relayUrl, hostClient);
      endpointStatuses.set(relayUrl, hostClient.getStatus());
    }
    refreshStatusFromEndpoints();
    ensureClaimWatch();
  };

  const stop = () => {
    stopClaimWatch();
    stopAllHostClients();
    if (hostLock) hostLock.release();
    status = { state: 'disabled', lastError: null, connectedClients: 0 };
  };

  const startIfEnabled = async () => {
    try {
      const config = await readConfig();
      if (config.enabled) {
        await start(config.relayUrls);
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
        if (!config.enabled) await writeConfig({ enabled: true, relayUrl: config.relayUrl, extraRelayUrls: config.extraRelayUrls });
        if (hostClients.size === 0) {
          const next = await readConfig();
          await start(next.relayUrls);
        }
      } else if (config.enabled && !isDesktopRelayHostRuntime()) {
        // Sticky opt-in on ssh-remote (and any future non-desktop host runtime).
        if (hostClients.size === 0) await start(config.relayUrls);
      } else {
        if (config.enabled) await writeConfig({ enabled: false, relayUrl: config.relayUrl, extraRelayUrls: config.extraRelayUrls });
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
    // `status` is the aggregate across endpoints (kept fresh by each host
    // client's onStatus callback), or the disabled/standby marker when none.
    const live = status;
    const endpoints = config.relayUrls.map((relayUrl) => {
      const client = hostClients.get(relayUrl);
      const entry = client ? client.getStatus() : endpointStatuses.get(relayUrl);
      return {
        relayUrl,
        state: client ? (entry?.state ?? 'connecting') : 'disabled',
        connectedClients: entry?.connectedClients ?? 0,
        ...(entry?.lastError ? { lastError: entry.lastError } : {}),
      };
    });
    return {
      enabled: config.enabled,
      hostAllowed: true,
      // Without host clients the service is either off or standing by while
      // another local process owns the machine's relay host claim.
      state: hostClients.size > 0 ? live.state : (status.state === 'standby' ? 'standby' : 'disabled'),
      serverId: identity.serverId,
      // Public E2EE trust anchor. Desktop SSH attach uses this to persist a
      // multi-transport host (local-forward + relay) without a pairing round-trip.
      hostEncPubJwk: identity.hostEncPubJwk,
      connectedClients: live.connectedClients,
      // Primary endpoint (push + default pairing); `relayUrls`/`endpoints` carry
      // the full multi-relay picture.
      relayUrl: config.relayUrl,
      relayUrls: config.relayUrls,
      endpoints,
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
  const buildPairingCandidate = async (relayUrl) => {
    const identity = await identityRuntime.getRelayIdentity();
    return {
      type: 'relay',
      relayUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      priority: 30,
    };
  };

  const getPairingCandidate = async () => {
    if (!hostAllowed()) return null;
    const config = await readConfig();
    if (!config.enabled) return null;
    return buildPairingCandidate(config.relayUrl);
  };

  // Candidates for every configured endpoint, used by the connection-candidates
  // refresh so already-paired devices learn the full reachable endpoint set.
  const getPairingCandidates = async () => {
    if (!hostAllowed()) return [];
    const config = await readConfig();
    if (!config.enabled) return [];
    const identity = await identityRuntime.getRelayIdentity();
    return config.relayUrls.map((relayUrl) => ({
      type: 'relay',
      relayUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      priority: 30,
    }));
  };

  // Enable the relay host on demand and return the pairing candidate for one
  // endpoint. Creating a relay pairing link IS the demand signal, so the relay
  // turns itself on here rather than requiring a separate manual toggle.
  // Idempotent for an endpoint that already exists; a NEW endpoint (owner
  // request only) is APPENDED as an additional relay rather than replacing the
  // primary, so devices already paired over the old endpoint keep working.
  const ensureEnabledForPairing = async (requestedRelayUrl) => {
    assertHostAllowed();
    const config = await readConfig();
    let targetUrl = config.relayUrl;
    let extraRelayUrls = config.extraRelayUrls;
    if (!config.relayUrlLocked && requestedRelayUrl !== undefined) {
      const canonical = canonicalizeRelayUrl(requestedRelayUrl);
      if (!canonical) {
        const error = new Error('Relay URL must use ws:// or wss://');
        error.statusCode = 400;
        throw error;
      }
      if (canonical === config.relayUrl || config.extraRelayUrls.includes(canonical)) {
        // Existing endpoint: pair over it without touching the endpoint set.
        targetUrl = canonical;
      } else {
        // New endpoint: append as an additional relay (multi-relay). The
        // primary is never replaced here — use /relay/enable for that.
        extraRelayUrls = [...config.extraRelayUrls, canonical];
        targetUrl = canonical;
      }
    }

    const endpointsChanged = extraRelayUrls.join('\n') !== config.extraRelayUrls.join('\n');
    if (!config.enabled || endpointsChanged) {
      await writeConfig({ enabled: true, relayUrl: config.relayUrl, extraRelayUrls });
    }
    const next = await readConfig();
    if (next.relayUrl !== config.relayUrl) {
      await notifyRelayUrlChanged();
    }
    // Force-claim: creating a pairing link is explicit user intent — the
    // instance the user is pairing against MUST be the one devices reach,
    // even if another local process currently holds the machine's claim
    // (its claim watcher sees the takeover and stands down). Also brings up
    // any endpoint that is configured but not live yet.
    await start(next.relayUrls, { claim: 'force' });
    return buildPairingCandidate(targetUrl);
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
        await writeConfig({ enabled: true, relayUrl, extraRelayUrls: current.extraRelayUrls });
        const next = await readConfig();
        if (next.relayUrl !== current.relayUrl) {
          await notifyRelayUrlChanged();
        }
        // The primary endpoint changed: drop the old control connection before
        // re-establishing (the extras keep their connections).
        if (next.relayUrl !== current.relayUrl) stopHostClient(current.relayUrl);
        // Explicit user action: take the machine's host claim like pairing does.
        await start(next.relayUrls, { claim: 'force' });
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
        await writeConfig({ enabled: false, relayUrl: current.relayUrl, extraRelayUrls: current.extraRelayUrls });
        stop();
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to disable relay' });
      }
    });

    // Manage the ADDITIONAL relay endpoints (multi-relay). Body:
    //   { relayUrls: string[] } — full replacement list of extra endpoints
    //     (primary excluded; an empty array removes every extra endpoint).
    // Owner-only: a UI session or the local desktop shell. Paired remote
    // clients never add or remove a host's relay endpoints — the same boundary
    // that keeps them from re-pointing the primary.
    app.post('/api/openchamber/relay/endpoints', express.json({ limit: '16kb' }), async (req, res) => {
      try {
        if (!hostAllowed()) {
          return res.status(403).json({ error: RELAY_HOST_DESKTOP_ONLY_MESSAGE });
        }
        if (!Array.isArray(req.body?.relayUrls)) {
          return res.status(400).json({ error: 'relayUrls must be an array of ws:// or wss:// endpoints' });
        }
        for (const entry of req.body.relayUrls) {
          if (canonicalizeRelayUrl(entry) === null) {
            return res.status(400).json({ error: 'Relay URL must use ws:// or wss://' });
          }
        }
        if (!(await isOwnerRequest(req, res))) {
          return res.status(403).json({ error: 'Only the owner UI session can manage relay endpoints' });
        }
        const current = await readConfig();
        const primary = current.relayUrl;
        const requested = normalizeExtraRelayUrls(req.body.relayUrls).filter((url) => url !== primary);
        if (!current.enabled) {
          // Nothing is hosted yet: just persist; the next pairing/demand cycle
          // brings the endpoints up.
          await writeConfig({ enabled: false, relayUrl: primary, extraRelayUrls: requested });
          return res.json(await getStatus());
        }
        await writeConfig({ enabled: true, relayUrl: primary, extraRelayUrls: requested });
        // Incremental lifecycle: stop removed endpoints, start added ones.
        for (const removed of current.extraRelayUrls.filter((url) => !requested.includes(url))) {
          stopHostClient(removed);
        }
        await start([primary, ...requested], { claim: 'force' });
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to update relay endpoints' });
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
    getPairingCandidates,
    ensureEnabledForPairing,
  };
};
