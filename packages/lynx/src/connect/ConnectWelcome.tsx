import { useEffect, useState } from 'react';

import type { LynxConnectionClient } from '../connection/client';
import type { LynxPendingConnection, LynxSavedConnection } from '../connection/types';
import { connectionDisplayUrl } from '../connection/urls';
import { lynxT } from '../i18n/catalog';
import { LynxScrollView, LynxText, LynxView } from '../lynx-elements';
import { LYNX_LIGHT_FALLBACKS, cssVar } from '../theme/tokens';
import type { LynxAutoConnectPhase } from './autoConnectPhase';
import type { LynxCameraAdapter } from '../host/camera';
import { parsePastedPairingLink } from './pairingPaste';

export type ConnectWelcomeProps = {
  locale: string;
  phase: LynxAutoConnectPhase;
  autoConnectLabel?: string | null;
  client: LynxConnectionClient | null;
  connections: LynxSavedConnection[];
  pending?: LynxPendingConnection | null;
  error?: string | null;
  onConnected: () => void;
  onConnectionsChange: (connections: LynxSavedConnection[]) => void;
  onPendingChange: (pending: LynxPendingConnection | null) => void;
  onError: (message: string | null) => void;
  /** Cap 扫一扫 — host camera; honest unavailable without binder. */
  cameraAdapter?: LynxCameraAdapter | null;
};

/**
 * Cap welcome / splash while auto-connect resolves, then instance list +
 * paste pairing link. QR camera remains a labeled stub (host-owned).
 */
export function ConnectWelcome({
  locale,
  phase,
  autoConnectLabel,
  client,
  connections,
  pending = null,
  error = null,
  onConnected,
  onConnectionsChange,
  onPendingChange,
  onError,
  cameraAdapter = null,
}: ConnectWelcomeProps) {
  const [pasteValue, setPasteValue] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [addLabel, setAddLabel] = useState('');
  const [addUrl, setAddUrl] = useState('');

  // First-paint must never depend solely on unresolved Cap CSS vars — cream + dark
  // text stay visible even when the host has not injected theme styles.
  const splashBg = LYNX_LIGHT_FALLBACKS['surface.background'];
  const splashFg = LYNX_LIGHT_FALLBACKS['surface.foreground'];
  const splashMuted = LYNX_LIGHT_FALLBACKS['surface.mutedForeground'];

  useEffect(() => {
    if (phase === 'done') return;
    // Emulator smoke greps this line (logcat / Lynx console) as proof splash mounted.
    console.log('[OpenChamberLynx] ConnectWelcome splash');
  }, [phase]);


  if (phase !== 'done') {
    // Hard literals first so a blank cream screen is impossible even if i18n fails.
    // Root <page> is provided by App — keep splash as a full-size <view>.
    return (
      <LynxView
        style={{
          flexGrow: 1,
          width: '100%',
          height: '100%',
          minHeight: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          // Hardcoded Flexoki-light cream — never transparent on black windowBackground.
          backgroundColor: splashBg,
        }}
        accessibility-label="OpenChamber Lynx"
      >
        <LynxText style={{ color: splashFg, fontSize: '22px', fontWeight: '700' }}>
          OpenChamber Lynx
        </LynxText>
        <LynxText style={{ color: splashFg, fontSize: '18px', fontWeight: '600', marginTop: '12px' }}>
          Connecting…
        </LynxText>
        <LynxText style={{ color: splashMuted, fontSize: '14px', marginTop: '8px' }}>
          {lynxT(locale, 'lynx.connect.splash')}
        </LynxText>
        {autoConnectLabel ? (
          <LynxText style={{ color: splashMuted, marginTop: '8px' }}>
            {autoConnectLabel}
          </LynxText>
        ) : null}
      </LynxView>
    );
  }

  const redeemPaste = async () => {
    if (!client || busy) return;
    const parsed = parsePastedPairingLink(pasteValue);
    if (parsed.status === 'empty') {
      onError(lynxT(locale, 'lynx.connect.paste.empty'));
      return;
    }
    if (parsed.status === 'invalid') {
      onError(lynxT(locale, 'lynx.connect.paste.invalid'));
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const result = await client.redeemPairingConnection(parsed.pairing);
      if (result.status === 'connected') {
        onConnectionsChange(client.loadConnections());
        onPendingChange(null);
        onConnected();
        return;
      }
      if (result.status === 'needs-login') {
        onPendingChange(result.pending);
        return;
      }
      onError(result.error);
    } finally {
      setBusy(false);
    }
  };

  const connectSaved = async (connection: LynxSavedConnection) => {
    if (!client || busy) return;
    setBusy(true);
    onError(null);
    try {
      const result = await client.connect({ id: connection.id, candidates: connection.candidates });
      if (result.status === 'connected') {
        onConnectionsChange(client.loadConnections());
        onPendingChange(null);
        onConnected();
        return;
      }
      if (result.status === 'needs-login') {
        onPendingChange(result.pending);
        return;
      }
      onError(result.error);
    } finally {
      setBusy(false);
    }
  };

  const removeSaved = async (id: string) => {
    if (!client || busy) return;
    setBusy(true);
    try {
      const next = await client.remove(id);
      onConnectionsChange(next);
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async () => {
    if (!client || !pending || busy) return;
    setBusy(true);
    onError(null);
    try {
      const result = await client.submitPassword(pending, password);
      setPassword('');
      if (result.status === 'connected') {
        onConnectionsChange(client.loadConnections());
        onPendingChange(null);
        onConnected();
        return;
      }
      if (result.status === 'needs-login') {
        onPendingChange(result.pending);
        return;
      }
      onError(result.error);
    } finally {
      setBusy(false);
    }
  };

  const addManual = async () => {
    if (!client || busy) return;
    const url = addUrl.trim();
    if (!url) {
      onError(lynxT(locale, 'lynx.connect.add.urlRequired'));
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const result = await client.connect({
        url,
        label: addLabel.trim() || undefined,
      });
      if (result.status === 'connected') {
        onConnectionsChange(client.loadConnections());
        onPendingChange(null);
        setAddLabel('');
        setAddUrl('');
        onConnected();
        return;
      }
      if (result.status === 'needs-login') {
        onConnectionsChange(client.loadConnections());
        onPendingChange(result.pending);
        return;
      }
      onError(result.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <LynxScrollView
      style={{
        flexGrow: 1,
        width: '100%',
        height: '100%',
        padding: '24px 16px',
        backgroundColor: cssVar('surface.background'), // var(--surface-background, #fffdf4)
      }}
      accessibility-label="OpenChamber Lynx"
    >
      <LynxText
        style={{
          fontSize: '28px',
          fontWeight: '700',
          color: cssVar('surface.foreground'),
          marginBottom: '8px',
        }}
      >
        {lynxT(locale, 'lynx.connect.welcome.title')}
      </LynxText>
      <LynxText style={{ color: cssVar('surface.mutedForeground'), marginBottom: '20px' }}>
        {lynxT(locale, 'lynx.connect.welcome.body')}
      </LynxText>

      {error ? (
        <LynxText style={{ color: cssVar('surface.foreground'), marginBottom: '12px' }}>
          {error}
        </LynxText>
      ) : null}

      {pending ? (
        <LynxView
          style={{
            marginBottom: '20px',
            padding: '12px',
            borderRadius: '12px',
            backgroundColor: cssVar('surface.elevated'),
          }}
        >
          <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600', marginBottom: '8px' }}>
            {lynxT(locale, 'lynx.connect.password.title')}: {pending.label}
          </LynxText>
          <LynxText
            style={{ color: password ? cssVar('surface.foreground') : cssVar('surface.mutedForeground') }}
            bindtap={() => setPassword(password ? '' : '•')}
          >
            {password ? '••••••••' : lynxT(locale, 'lynx.connect.password.placeholder')}
          </LynxText>
          <LynxView style={{ flexDirection: 'row', marginTop: '12px', gap: '12px' }}>
            <LynxView bindtap={() => void submitPassword()} accessibility-role="button">
              <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
                {lynxT(locale, 'lynx.connect.password.submit')}
              </LynxText>
            </LynxView>
            <LynxView
              bindtap={() => {
                onPendingChange(null);
                setPassword('');
              }}
              accessibility-role="button"
            >
              <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
                {lynxT(locale, 'lynx.connect.password.cancel')}
              </LynxText>
            </LynxView>
          </LynxView>
        </LynxView>
      ) : null}

      <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '13px', fontWeight: '600', marginBottom: '8px' }}>
        {lynxT(locale, 'lynx.connect.instances')}
      </LynxText>
      {connections.length === 0 ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), marginBottom: '16px' }}>
          {lynxT(locale, 'lynx.connect.instances.empty')}
        </LynxText>
      ) : (
        connections.map((connection) => (
          <LynxView
            key={connection.id}
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 0',
            }}
          >
            <LynxView bindtap={() => void connectSaved(connection)} style={{ flexGrow: 1 }}>
              <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600' }}>
                {connection.label}
              </LynxText>
              <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px' }}>
                {connectionDisplayUrl(connection)}
              </LynxText>
            </LynxView>
            <LynxView bindtap={() => void removeSaved(connection.id)} accessibility-role="button">
              <LynxText style={{ color: cssVar('surface.mutedForeground') }}>
                {lynxT(locale, 'lynx.connect.instances.delete')}
              </LynxText>
            </LynxView>
          </LynxView>
        ))
      )}

      <LynxView
        style={{
          marginTop: '16px',
          marginBottom: '16px',
          padding: '12px',
          borderRadius: '12px',
          backgroundColor: cssVar('surface.elevated'),
        }}
      >
        <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600', marginBottom: '8px' }}>
          {lynxT(locale, 'lynx.connect.paste.title')}
        </LynxText>
        <LynxText
          style={{ color: pasteValue ? cssVar('surface.foreground') : cssVar('surface.mutedForeground') }}
          bindtap={() => setPasteValue(pasteValue ? '' : 'openchamber://')}
        >
          {pasteValue || lynxT(locale, 'lynx.connect.paste.placeholder')}
        </LynxText>
        <LynxView bindtap={() => void redeemPaste()} style={{ marginTop: '12px' }} accessibility-role="button">
          <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
            {lynxT(locale, 'lynx.connect.paste.submit')}
          </LynxText>
        </LynxView>
      </LynxView>

      <LynxView
        style={{
          marginBottom: '16px',
          padding: '12px',
          borderRadius: '12px',
          backgroundColor: cssVar('surface.elevated'),
        }}
      >
        <LynxText style={{ color: cssVar('surface.foreground'), fontWeight: '600', marginBottom: '8px' }}>
          {lynxT(locale, 'lynx.connect.add.title')}
        </LynxText>
        <LynxText
          style={{ color: addUrl ? cssVar('surface.foreground') : cssVar('surface.mutedForeground'), marginBottom: '6px' }}
          bindtap={() => setAddUrl(addUrl ? '' : 'http://127.0.0.1:4096')}
        >
          {addUrl || lynxT(locale, 'lynx.connect.add.urlPlaceholder')}
        </LynxText>
        <LynxText
          style={{ color: addLabel ? cssVar('surface.foreground') : cssVar('surface.mutedForeground') }}
          bindtap={() => setAddLabel(addLabel ? '' : 'Local')}
        >
          {addLabel || lynxT(locale, 'lynx.connect.add.labelPlaceholder')}
        </LynxText>
        <LynxView bindtap={() => void addManual()} style={{ marginTop: '12px' }} accessibility-role="button">
          <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
            {lynxT(locale, 'lynx.connect.add.submit')}
          </LynxText>
        </LynxView>
      </LynxView>

      <LynxView
        bindtap={() => {
          void (async () => {
            if (!cameraAdapter) {
              onError(lynxT(locale, 'lynx.connect.qr.unavailable'));
              return;
            }
            setBusy(true);
            onError(null);
            try {
              const result = await cameraAdapter.scanPairingQr();
              if (result.status === 'pairing' && client) {
                const redeemed = await client.redeemPairingConnection(result.pairing);
                if (redeemed.status === 'connected') {
                  onConnectionsChange(client.loadConnections());
                  onPendingChange(null);
                  onConnected();
                  return;
                }
                if (redeemed.status === 'needs-login') {
                  onPendingChange(redeemed.pending);
                  return;
                }
                onError(redeemed.error);
                return;
              }
              if (result.status === 'ok' && client) {
                const connected = await client.connect({
                  url: result.url,
                  clientToken: result.clientToken,
                  label: result.label,
                });
                if (connected.status === 'connected') {
                  onConnectionsChange(client.loadConnections());
                  onConnected();
                  return;
                }
                if (connected.status === 'needs-login') {
                  onPendingChange(connected.pending);
                  return;
                }
                onError(typeof connected.error === 'string' ? connected.error : String(connected.error));
                return;
              }
              if (result.status === 'cancelled') return;
              if (result.status === 'unavailable' || result.status === 'unsupported') {
                onError(lynxT(locale, 'lynx.connect.qr.unavailable'));
                return;
              }
              onError(lynxT(locale, 'lynx.connect.qr.unavailable'));
            } finally {
              setBusy(false);
            }
          })();
        }}
        style={{
          marginBottom: '16px',
          padding: '12px',
          borderRadius: '12px',
          backgroundColor: cssVar('surface.elevated'),
        }}
        accessibility-role="button"
        accessibility-label={lynxT(locale, 'lynx.connect.qr.scan')}
      >
        <LynxText style={{ color: cssVar('primary.base'), fontWeight: '600' }}>
          {lynxT(locale, 'lynx.connect.qr.scan')}
        </LynxText>
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginTop: '4px' }}>
          {cameraAdapter?.isAvailable()
            ? lynxT(locale, 'lynx.connect.qr.scan')
            : lynxT(locale, 'lynx.connect.qr.unavailable')}
        </LynxText>
      </LynxView>
    </LynxScrollView>
  );
}
