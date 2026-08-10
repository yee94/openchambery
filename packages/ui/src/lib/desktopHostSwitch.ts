import { isElectronShell } from '@/lib/desktop';
import {
  desktopHostProbe,
  getDesktopHostApiUrl,
  normalizeHostUrl,
  probeRelayDesktopHost,
  type DesktopHost,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import { scheduleDesktopHostCandidateRefresh } from '@/lib/desktopRelayRestore';
import { adoptRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

export type DesktopHostProbeSnapshot = {
  status: HostProbeResult['status'];
  latencyMs: number;
  /** Which transport the successful probe used (multi-transport hosts). */
  via?: 'relay';
};

const isBlockedHostStatus = (status: HostProbeResult['status'] | null | undefined): boolean => {
  return status === 'unreachable' || status === 'wrong-service' || status === 'incompatible';
};

/** Stable runtime key for a saved desktop host. Must match DesktopHostSwitcher / relay restore. */
export const runtimeKeyForDesktopHost = (host: DesktopHost): string => {
  if (host.id === 'local') return 'local';
  return `host:${host.id}`;
};

/** Whether this host is the active runtime endpoint. */
export const isDesktopHostActive = (host: DesktopHost): boolean => {
  return getRuntimeKey() === runtimeKeyForDesktopHost(host);
};

export type SwitchDesktopHostResult =
  | { ok: true; via: 'direct' | 'relay'; status: DesktopHostProbeSnapshot }
  | { ok: false; status: DesktopHostProbeSnapshot; reason: 'unreachable' | 'unsupported' };

/**
 * Switch the Electron renderer runtime to a saved desktop host (direct first,
 * relay fallback). No-op outside Electron. Callers surface toasts for failures.
 */
export const switchDesktopHost = async (
  host: DesktopHost,
  options?: { cachedProbe?: DesktopHostProbeSnapshot | null },
): Promise<SwitchDesktopHostResult> => {
  if (!isElectronShell()) {
    return { ok: false, status: { status: 'unreachable', latencyMs: 0 }, reason: 'unsupported' };
  }

  const apiOrigin = normalizeHostUrl(getDesktopHostApiUrl(host)) || '';
  // Need at least one transport: a direct API origin and/or a relay leg.
  if (!apiOrigin && !host.relay) {
    return { ok: false, status: { status: 'unreachable', latencyMs: 0 }, reason: 'unreachable' };
  }

  const activateRelay = (
    relay: NonNullable<DesktopHost['relay']>,
    liveTunnel?: ReturnType<typeof createRelayTunnelClient>,
  ) => {
    // Adopt the probe's live tunnel (when it kept one) BEFORE the switch: the
    // activate call inside switchRuntimeEndpoint sees an equal descriptor and
    // reuses it — no second WebSocket connect + E2EE handshake.
    if (liveTunnel) {
      adoptRelayTunnel({
        relayUrl: relay.relayUrl,
        serverId: relay.serverId,
        hostEncPubJwk: relay.hostEncPubJwk,
      }, liveTunnel);
    }
    switchRuntimeEndpoint({
      apiBaseUrl: typeof window !== 'undefined' ? window.location.origin : '',
      clientToken: host.clientToken || null,
      runtimeKey: runtimeKeyForDesktopHost(host),
      relay,
    });
    // On the relay: learn the server's current LAN address in the background
    // and hot-switch back to direct if the stored one merely went stale.
    scheduleDesktopHostCandidateRefresh(host.id);
  };

  const switchDirect = (origin: string) => {
    switchRuntimeEndpoint({
      apiBaseUrl: origin,
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
      runtimeKey: runtimeKeyForDesktopHost(host),
    });
  };

  const cached = options?.cachedProbe;
  if (cached?.status === 'ok') {
    if (cached.via === 'relay' && host.relay) {
      activateRelay(host.relay);
      return { ok: true, via: 'relay', status: cached };
    }
    if (apiOrigin && cached.via !== 'relay') {
      switchDirect(apiOrigin);
      return { ok: true, via: 'direct', status: cached };
    }
    if (host.relay) {
      activateRelay(host.relay);
      return { ok: true, via: 'relay', status: { ...cached, via: 'relay' } };
    }
  }

  // No usable probe result — probe now: direct first, relay fallback.
  // Statuses are written once, with the final outcome, so the row never
  // flashes intermediate failures while the fallback is still running.
  let finalStatus: DesktopHostProbeSnapshot = { status: 'unreachable', latencyMs: 0 };
  let transport: 'direct' | 'relay' | null = null;
  let relayProbeTunnel: ReturnType<typeof createRelayTunnelClient> | undefined;

  if (apiOrigin) {
    const probe = await desktopHostProbe(apiOrigin, {
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
    }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
    finalStatus = { status: probe.status, latencyMs: probe.latencyMs };
    if (!isBlockedHostStatus(probe.status)) transport = 'direct';
  }

  if (!transport && host.relay) {
    const probe = await probeRelayDesktopHost(host.relay, { keepTunnel: true })
      .catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
    if (probe.status === 'ok') {
      finalStatus = { status: probe.status, latencyMs: probe.latencyMs, via: 'relay' };
      transport = 'relay';
      relayProbeTunnel = 'tunnel' in probe ? probe.tunnel : undefined;
    } else if (!apiOrigin) {
      finalStatus = { status: probe.status, latencyMs: probe.latencyMs };
    }
  }

  if (!transport) {
    return { ok: false, status: finalStatus, reason: 'unreachable' };
  }

  if (transport === 'relay' && host.relay) {
    activateRelay(host.relay, relayProbeTunnel);
    return { ok: true, via: 'relay', status: finalStatus };
  }

  switchDirect(apiOrigin);
  return { ok: true, via: 'direct', status: finalStatus };
};
