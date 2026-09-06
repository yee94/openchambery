import { useEffect, useMemo, useState } from 'react';

import {
  createLynxConnectionClient,
  type LynxConnectionClient,
} from './connection/client';
import {
  createMemoryKvStore,
  createMemorySecureStore,
} from './connection/persist';
import type { LynxPendingConnection, LynxSavedConnection } from './connection/types';
import { ConnectWelcome } from './connect/ConnectWelcome';
import {
  nextAutoConnectPhase,
  resolveLynxConnectGate,
  type LynxAutoConnectPhase,
} from './connect/autoConnectPhase';
import { createHostGlobalProps, type LynxHostGlobalProps } from './host/embedding';
import { LynxPage } from './lynx-elements';
import { createSessionIndexHomeBindings, createLynxSessionIndexStore } from './session-index/store';
import { LynxShellApp } from './shell/ShellApp';

/** Root `<page>` styles — Lynx first-screen without page often paints blank cream. */
const ROOT_PAGE_STYLE = {
  width: '100%',
  height: '100%',
  flexGrow: 1,
  backgroundColor: '#fffdf4',
} as const;

export type AppProps = {
  host?: LynxHostGlobalProps;
  /** Injected client for tests / host. When omitted, memory stores are used. */
  connectionClient?: LynxConnectionClient | null;
  /** Skip splash auto-connect (tests). */
  skipAutoConnect?: boolean;
  lynxClientVersion?: string;
};


function readLynxGlobalProps(): Partial<LynxHostGlobalProps> | undefined {
  try {
    const gp = (globalThis as { lynx?: { __globalProps?: Partial<LynxHostGlobalProps> } }).lynx
      ?.__globalProps;
    return gp && typeof gp === 'object' ? gp : undefined;
  } catch {
    return undefined;
  }
}

function resolveHostFromGlobalProps(): LynxHostGlobalProps {
  const gp = readLynxGlobalProps();
  const themeId =
    gp?.themeId === 'flexoki-dark' || gp?.themeId === 'flexoki-light' ? gp.themeId : undefined;
  return createHostGlobalProps({
    platform: gp?.platform === 'ios' ? 'ios' : 'android',
    themeId,
    locale: typeof gp?.locale === 'string' && gp.locale.length > 0 ? gp.locale : undefined,
  });
}

/**
 * Full-page Lynx entry. Hosts that own Tab/Nav (Mode B) pass
 * `chromeOwner: 'host'` so this tree does not paint a second dock.
 * Shows splash while auto-connect resolves, then welcome or shell.
 */
export function App({
  host,
  connectionClient: injectedClient = null,
  skipAutoConnect = false,
  lynxClientVersion = '1.19.7-beta.7',
}: AppProps) {
  const resolved = host ?? resolveHostFromGlobalProps();

  const client = useMemo(() => {
    if (injectedClient) return injectedClient;
    return createLynxConnectionClient({
      metadataStore: createMemoryKvStore(),
      secureStore: createMemorySecureStore(),
    });
  }, [injectedClient]);

  const [phase, setPhase] = useState<LynxAutoConnectPhase>(skipAutoConnect ? 'done' : 'pending');
  const [connected, setConnected] = useState(false);
  const [connections, setConnections] = useState<LynxSavedConnection[]>(() => client.loadConnections());
  const [pending, setPending] = useState<LynxPendingConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoConnectLabel, setAutoConnectLabel] = useState<string | null>(null);

  useEffect(() => {
    if (skipAutoConnect) return;
    let cancelled = false;
    setPhase((current) => nextAutoConnectPhase(current, 'start'));
    const target = client.loadConnections()[0];
    setAutoConnectLabel(target?.label ?? null);
    void (async () => {
      try {
        const ok = await client.autoConnectLastInstance();
        if (cancelled) return;
        if (ok) {
          setConnected(true);
          setConnections(client.loadConnections());
        }
      } finally {
        if (!cancelled) setPhase((current) => nextAutoConnectPhase(current, 'finish'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, skipAutoConnect]);

  const gate = resolveLynxConnectGate({ phase, connected, autoConnectLabel });

  const sessionIndexBindings = useMemo(() => {
    if (!connected) return null;
    const store = createLynxSessionIndexStore({
      runtimeFetch: client.runtimeFetch,
      getRuntimeKey: () => client.identity.get()?.runtimeKey ?? null,
    });
    return createSessionIndexHomeBindings(store);
  }, [client, connected]);

  if (gate.kind === 'splash' || gate.kind === 'welcome') {
    return (
      <LynxPage style={ROOT_PAGE_STYLE} accessibility-label="OpenChamber Lynx">
        <ConnectWelcome
          locale={resolved.locale}
          phase={phase}
          autoConnectLabel={autoConnectLabel}
          client={client}
          connections={connections}
          pending={pending}
          error={error}
          onConnected={() => setConnected(true)}
          onConnectionsChange={setConnections}
          onPendingChange={setPending}
          onError={setError}
        />
      </LynxPage>
    );
  }

  return (
    <LynxPage style={ROOT_PAGE_STYLE} auto-height accessibility-label="OpenChamber Lynx">
      <LynxShellApp
        host={resolved}
        runtimeFetch={client.runtimeFetch}
        sessionIndexBindings={sessionIndexBindings}
        connectionClient={client}
        connections={connections}
        onConnectionsChange={setConnections}
        onConnected={() => setConnected(true)}
        lynxClientVersion={lynxClientVersion}
      />
    </LynxPage>
  );
}
