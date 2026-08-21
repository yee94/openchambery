// Opens a runtime WebSocket the right way for the active runtime: through the
// relay tunnel when relay mode is active, or a native browser WebSocket
// otherwise (wrapped to the same shape). Every runtime WS consumer — the event
// pipeline, dictation, terminal — must go through here so relay mode carries
// ALL socket traffic, not just the main event stream. A raw `new WebSocket(url)`
// against a relay-mode runtime fails: the resolver yields a tunnel-virtual URL
// (or a capacitor:// origin) that the platform WebSocket rejects with
// "The string did not match the expected pattern".

import { getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { getActiveRelayTunnel } from './runtime-tunnel';
import { wsUrlToTunnelPath } from './tunnel-payloads';
import { wrapBrowserWebSocket, type RelayTunnelWebSocket } from './tunnel-client';

/** Must match `OPENCHAMBER_TARGET_PORT_HEADER` in runtime-switch (avoid import cycle). */
const TARGET_PORT_HEADER = 'x-openchamber-target-port';

const relayWsOpenHeaders = (): Record<string, string> | undefined => {
  const extras = getRuntimeExtraHeadersSync();
  for (const [key, value] of Object.entries(extras)) {
    if (key.trim().toLowerCase() !== TARGET_PORT_HEADER) continue;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return { [TARGET_PORT_HEADER]: trimmed };
  }
  return undefined;
};

export const openRuntimeWebSocket = (url: string, protocols?: string[]): RelayTunnelWebSocket => {
  const relay = getActiveRelayTunnel();
  if (relay) {
    return relay.openWebSocket(wsUrlToTunnelPath(url), protocols, relayWsOpenHeaders());
  }
  return wrapBrowserWebSocket(protocols ? new WebSocket(url, protocols) : new WebSocket(url));
};
