import type { HostProbeResult } from '@/lib/desktopHosts';

export type HostRowDisplayStatus = HostProbeResult['status'] | 'checking' | null;

/** Snapshot of a host probe used only for display decisions. */
export type HostRowProbeSnapshot = {
  status: HostProbeResult['status'];
  latencyMs: number;
  /** Which transport the successful probe used (multi-transport hosts). */
  via?: 'relay';
};

export type ResolveHostRowDisplayArgs = {
  isActive: boolean;
  isSsh: boolean;
  /** Authoritative runtime connection for the active host. */
  runtimeIsConnected: boolean;
  runtimeConnectionPhase: string;
  /** Whether the current runtime transport is relay (active host only). */
  currentTransportIsRelay: boolean;
  probe: HostRowProbeSnapshot | null | undefined;
  sshPhase: string | undefined;
};

export type HostRowDisplay = {
  statusKind: HostRowDisplayStatus;
  /** Relay badge: active uses live transport; inactive uses probe via. */
  showViaRelay: boolean;
  /** Latency to show next to status; null when it must not be shown. */
  latencyMs: number | null;
};

/** Map SSH tunnel phase to the host-row status used for inactive SSH rows. */
export function sshPhaseToHostDisplayStatus(
  phase: string | undefined,
): HostRowDisplayStatus {
  if (!phase || phase === 'idle') return null;
  if (phase === 'ready') return 'ok';
  if (phase === 'error') return 'unreachable';
  return 'auth';
}

function probeMatchesTransport(
  probe: HostRowProbeSnapshot,
  expectRelay: boolean,
): boolean {
  const probeIsRelay = probe.via === 'relay';
  return expectRelay ? probeIsRelay : !probeIsRelay;
}

/**
 * Resolve per-row status, Relay badge, and ping for the desktop host switcher.
 *
 * Active host status is owned by runtime connection (isConnected + phase), not
 * the last probe. Ping is only shown when a real probe result matches the
 * transport that the badge represents — never "stale direct latency + Relay".
 */
export function resolveHostRowDisplay(args: ResolveHostRowDisplayArgs): HostRowDisplay {
  const {
    isActive,
    isSsh,
    runtimeIsConnected,
    runtimeConnectionPhase,
    currentTransportIsRelay,
    probe,
    sshPhase,
  } = args;

  let statusKind: HostRowDisplayStatus;
  if (isActive) {
    statusKind =
      runtimeIsConnected && runtimeConnectionPhase === 'connected' ? 'ok' : 'checking';
  } else if (isSsh) {
    statusKind = sshPhaseToHostDisplayStatus(sshPhase);
  } else {
    statusKind = probe?.status ?? 'checking';
  }

  const showViaRelay = isActive ? currentTransportIsRelay : probe?.via === 'relay';

  let latencyMs: number | null = null;
  if (
    !isSsh &&
    statusKind === 'ok' &&
    probe?.status === 'ok' &&
    typeof probe.latencyMs === 'number'
  ) {
    // Active: latency must match the live transport. Inactive: probe is authoritative.
    if (!isActive || probeMatchesTransport(probe, currentTransportIsRelay)) {
      latencyMs = Math.max(0, Math.round(probe.latencyMs));
    }
  }

  return { statusKind, showViaRelay, latencyMs };
}
