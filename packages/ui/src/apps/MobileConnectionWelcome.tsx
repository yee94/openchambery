import React from 'react';
import { useEvent } from '@reactuses/core';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { YuriLogo } from '@/components/ui/YuriLogo';
import { YuriWordmark } from '@/components/ui/YuriWordmark';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { MobileWindowMotion } from '@/components/ui/MobileWindowMotion';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { MobileDetailNavigation } from '@/mobile/MobileDetailNavigation';
import { useI18n } from '@/lib/i18n';
import { isCapacitorApp } from '@/lib/platform';
import { MobilePairingLinkForm } from './MobilePairingLinkForm';
import { isQrScanSupported, scanConnectionQr } from './mobileQrScan';
import type { MobileSavedConnection, UseMobileConnection } from './mobileConnections';
import '@/components/ui/image-loading.css';
import './mobile-welcome.css';

type Panel = 'more' | 'rename' | 'remove' | null;

export function MobileConnectionWelcome({ connection: conn }: { connection: UseMobileConnection }) {
  const { t } = useI18n();
  const { connections, isBusy, error, pendingConnection } = conn;
  const qrSupported = React.useMemo(() => isQrScanSupported(), []);
  const [panel, setPanel] = React.useState<Panel>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [menuId, setMenuId] = React.useState<string | null>(null);
  const [isScanning, setIsScanning] = React.useState(false);
  const [attemptId, setAttemptId] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [pairingLink, setPairingLink] = React.useState('');
  const latest = connections[0];
  const editing = connections.find((item) => item.id === editingId);
  const disabled = isBusy || isScanning;
  const sheetOpen = panel !== null || pendingConnection !== null;

  const openPanel = (next: Panel) => {
    conn.setError(null);
    setPanel(next);
  };
  const openHistory = () => {
    conn.setError(null);
    setPanel(null);
    setHistoryOpen(true);
  };
  const closeSheet = useEvent(() => {
    if (disabled) return;
    if (pendingConnection) {
      conn.cancelPassword();
      setPassword('');
    } else {
      openPanel(null);
    }
  });

  const connectSaved = useEvent(async (saved: MobileSavedConnection) => {
    if (disabled) return;
    setAttemptId(saved.id);
    setPassword('');
    await conn.connect({ id: saved.id, candidates: saved.candidates, label: saved.label });
  });

  const scan = useEvent(async () => {
    if (disabled) return;
    setAttemptId(null);
    setIsScanning(true);
    conn.setError(null);
    try {
      const result = await scanConnectionQr();
      if (result.status === 'ok') {
        await conn.connect({ url: result.url, label: result.label, clientToken: result.clientToken });
      } else if (result.status === 'pairing') {
        await conn.redeemPairingConnection(result.pairing);
      } else if (result.status === 'permission-denied') {
        conn.setError(t('mobile.connect.scan.permissionDenied'));
      } else if (result.status === 'invalid') {
        conn.setError(t('mobile.connect.scan.invalid'));
      } else if (result.status === 'unsupported') {
        conn.setError(t('mobile.connect.scan.unsupported'));
      } else if (result.status === 'failed') {
        conn.setError(t('mobile.connect.scan.failed'));
      }
    } catch {
      conn.setError(t('mobile.connect.scan.failed'));
    } finally {
      setIsScanning(false);
    }
  });

  // Welcome is outside the connected app's native back-button owner.
  const back = useEvent(() => {
    if (menuId) { setMenuId(null); return true; }
    if (sheetOpen) { closeSheet(); return true; }
    if (historyOpen) { setHistoryOpen(false); return true; }
    return false;
  });
  React.useEffect(() => {
    if (!isCapacitorApp()) return;
    let disposed = false;
    let remove: (() => void) | undefined;
    void import('@capacitor/app').then(async ({ App }) => {
      const listener = await App.addListener('backButton', () => {
        if (!back()) void App.minimizeApp().catch(() => undefined);
      });
      if (disposed) void listener.remove();
      else remove = () => { void listener.remove(); };
    }).catch(() => undefined);
    return () => { disposed = true; remove?.(); };
  }, [back]);

  const status = (saved: MobileSavedConnection) => {
    if (attemptId === saved.id && isBusy && !pendingConnection && panel !== 'rename' && panel !== 'remove') return t('mobile.connect.connecting');
    if (attemptId === saved.id && error) return t('mobile.connect.history.failed');
    return saved.id === latest?.id && saved.lastUsedAt > 0
      ? t('mobile.connect.history.lastUsed')
      : t('mobile.instances.status.saved');
  };

  const scanButton = (primary: boolean) => (
    <Button size="lg" variant={primary ? 'default' : 'ghost'} className={primary ? 'yuri-welcome-primary w-full' : 'w-full'} disabled={disabled} onClick={() => void scan()}>
      <Icon name={isScanning ? 'loader-4' : 'scan-2'} className={isScanning ? 'size-5 animate-spin motion-reduce:animate-none' : 'size-5'} />
      {t('mobile.connect.scanQr')}
    </Button>
  );

  const sheetTitle = pendingConnection ? t('mobile.connect.password.label')
    : panel === 'rename' ? t('mobile.connect.history.rename')
      : panel === 'remove' ? t('mobile.connect.history.remove') : t('mobile.connect.welcome.moreOptions');

  return (
    <>
      <main className="yuri-keyboard-fill-screen yuri-mobile-welcome" inert={sheetOpen || historyOpen} aria-hidden={sheetOpen || historyOpen || undefined} data-welcome-paused={sheetOpen || historyOpen || isScanning ? 'true' : undefined}>
        <header className="yuri-welcome-brand">
          <YuriWordmark className="block" width={88} />
        </header>
        <div className="yuri-welcome-content">
          <div className="yuri-welcome-intro">
            <div className="yuri-welcome-art" aria-hidden="true">
              <span className="yuri-image-loading yuri-welcome-dots" />
              <div className="yuri-welcome-logo"><YuriLogo width={144} height={144} className="size-full" /></div>
            </div>
            <div className="yuri-welcome-copy">
              <h1>{t(latest ? 'mobile.connect.history.welcomeBack' : 'mobile.connect.welcome.heading')}</h1>
              <p>{t('mobile.connect.welcome.pairingHint')}</p>
            </div>
          </div>
          <div className="yuri-welcome-actions flex w-full flex-col gap-3">
            {latest ? (
              <>
                <Button variant="outline" className="yuri-welcome-device" disabled={disabled} onClick={openHistory}>
                  <Icon name="computer" className="size-7" />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate typography-ui-label">{latest.label}</span>
                    <span className="block typography-small font-normal text-muted-foreground">{status(latest)}</span>
                  </span>
                  <Icon name="arrow-right-s" className="size-5 text-muted-foreground" />
                </Button>
                <Button size="lg" className="yuri-welcome-primary w-full" disabled={disabled} onClick={() => void connectSaved(latest)}>
                  {isBusy && attemptId === latest.id ? t('mobile.connect.connecting') : error && attemptId === latest.id ? t('desktopHostSwitcher.actions.retry') : t('mobile.connect.history.continue')}
                </Button>
              </>
            ) : null}
            {qrSupported ? scanButton(!latest) : !latest ? (
              <Button size="lg" className="yuri-welcome-primary w-full" disabled={disabled} onClick={() => openPanel('more')}>{t('mobile.connect.link.useLink')}</Button>
            ) : null}
            {error && !sheetOpen && !historyOpen ? <p role="alert" className="typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button variant="ghost" size="lg" disabled={disabled} className="mx-auto text-muted-foreground" onClick={() => openPanel('more')}>
              {t('mobile.connect.welcome.moreOptions')}
            </Button>
          </div>
        </div>
      </main>

      <MobileWindowMotion id="welcome-history" open={historyOpen} onOpenChange={setHistoryOpen} presentation="page" edge="right" dismissGesture ariaLabel={t('mobile.connect.history.title')}>
        <MobileDetailNavigation title={t('mobile.connect.history.title')} backAriaLabel={t('header.actions.backAria')} onBack={() => setHistoryOpen(false)} />
        <ScrollableOverlay outerClassName="flex-1" className="px-6 py-6" disableHorizontal>
          <h1 className="typography-h1 mb-3">{t('mobile.connect.history.title')}</h1>
          <p className="mb-6 typography-ui-label font-normal text-muted-foreground">{t(connections.length ? 'mobile.connect.history.description' : 'mobile.connect.saved.empty')}</p>
          {connections.map((saved) => (
            <div key={saved.id} className="border-b border-border/60 py-3">
              <div className="flex items-center gap-2">
                <Button variant="ghost" className="yuri-welcome-history-row min-w-0 flex-1" disabled={disabled} onClick={() => void connectSaved(saved)}>
                  <Icon name={isBusy && attemptId === saved.id && !sheetOpen ? 'loader-4' : 'computer'} className={isBusy && attemptId === saved.id && !sheetOpen ? 'size-7 animate-spin motion-reduce:animate-none' : 'size-7'} />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate typography-ui-label">{saved.label}</span>
                    <span className="block typography-small font-normal text-muted-foreground">{status(saved)}</span>
                  </span>
                </Button>
                <DropdownMenu open={menuId === saved.id} onOpenChange={(open) => setMenuId(open ? saved.id : null)}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" disabled={disabled} aria-label={t('mobile.connect.history.actions', { name: saved.label })}><Icon name="more" className="size-5" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => { setEditingId(saved.id); setName(saved.label); openPanel('rename'); }}><Icon name="edit" className="size-4" />{t('mobile.connect.history.rename')}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => { setEditingId(saved.id); openPanel('remove'); }} className="text-[var(--status-error)]"><Icon name="delete-bin" className="size-4" />{t('mobile.connect.history.remove')}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {error && attemptId === saved.id && !sheetOpen ? (
                <div className="px-3 pb-2">
                  <p role="alert" className="typography-small text-[var(--status-error)]">{error}</p>
                  <Button variant="link" size="sm" disabled={disabled} onClick={() => void connectSaved(saved)}>{t('desktopHostSwitcher.actions.retry')}</Button>
                </div>
              ) : null}
            </div>
          ))}
          {error && !attemptId && !sheetOpen ? <p role="alert" className="typography-small text-[var(--status-error)]">{error}</p> : null}
        </ScrollableOverlay>
        <div className="yuri-welcome-history-footer">
          <YuriLogo width={36} height={36} className="mx-auto mb-5 opacity-40" />
          {qrSupported ? scanButton(false) : null}
          <Button variant="ghost" size="lg" className="w-full" disabled={disabled} onClick={() => openPanel('more')}>{t('mobile.connect.link.useLink')}</Button>
        </div>
      </MobileWindowMotion>

      <MobileResizableSheet id="welcome-options" open={sheetOpen} onOpenChange={(open) => { if (!open) closeSheet(); }} fitContent
        title={<h2 className="truncate typography-ui-label font-semibold">{sheetTitle}</h2>} ariaLabel={sheetTitle}
        closeAriaLabel={t('mobile.surface.closeAria')} resizeAriaLabel={t('mobile.connect.options.resize')}>
        <ScrollableOverlay className="px-5 py-5" disableHorizontal fillContainer={false}>
          {pendingConnection ? (
            <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (!isBusy) void conn.submitPassword(password); }}>
              <p className="truncate typography-ui-label">{pendingConnection.label}</p>
              <Input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-label={t('mobile.connect.password.label')} placeholder={t('mobile.connect.password.placeholder')} disabled={isBusy} />
              {error ? <p role="alert" className="typography-small text-[var(--status-error)]">{error}</p> : null}
              <Button type="submit" size="lg" className="yuri-welcome-primary w-full" disabled={isBusy || !password.trim()}>{t(isBusy ? 'mobile.connect.connecting' : 'mobile.connect.unlockButton')}</Button>
              <Button variant="ghost" disabled={isBusy} onClick={closeSheet}>{t('mobile.connect.cancelPassword')}</Button>
            </form>
          ) : panel === 'rename' && editing ? (
            <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void conn.renameConnection(editing.id, name).then((saved) => { if (saved) setPanel(null); }); }}>
              <Input value={name} onChange={(event) => setName(event.target.value)} disabled={isBusy} aria-label={t('mobile.instances.label.label')} autoComplete="off" maxLength={120} />
              {error ? <p role="alert" className="typography-small text-[var(--status-error)]">{error}</p> : null}
              <Button type="submit" size="lg" disabled={isBusy || !name.trim()}>{t('mobile.instances.saveEdit')}</Button>
            </form>
          ) : panel === 'remove' && editing ? (
            <div className="flex flex-col gap-4">
              <p className="typography-ui-label font-normal">{t('mobile.connect.history.removeHint', { name: editing.label })}</p>
              {error ? <p role="alert" className="typography-small text-[var(--status-error)]">{error}</p> : null}
              <Button variant="destructive" size="lg" disabled={isBusy} onClick={() => { void conn.removeConnection(editing.id).then((removed) => { if (removed) { setPanel(null); setAttemptId(null); } }); }}>{t('mobile.connect.history.remove')}</Button>
              <Button variant="ghost" disabled={isBusy} onClick={closeSheet}>{t('mobile.instances.cancelEdit')}</Button>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <div>
                <h3 className="typography-ui-header mb-2">{t('mobile.connect.link.useLink')}</h3>
                <p className="typography-small text-muted-foreground">{t('mobile.connect.link.help')}</p>
              </div>
              <MobilePairingLinkForm value={pairingLink} onValueChange={(value) => { setPairingLink(value); conn.setError(null); }} showPasteButton
                inputClassName="min-w-0 flex-1 text-[16px]" buttonClassName="yuri-welcome-primary w-full" buttonVariant="default"
                disabled={disabled} isBusy={isBusy} error={error}
                onInvalid={() => conn.setError(t('mobile.connect.link.invalid'))}
                onRedeem={(pairing) => { setAttemptId(null); void conn.redeemPairingConnection(pairing); }} />
              <Button variant="outline" className="yuri-welcome-history-row" disabled={disabled} onClick={openHistory}>
                <Icon name="history" className="size-6" />
                <span className="flex-1 text-left">{t('mobile.connect.history.title')}</span>
                <Icon name="arrow-right-s" className="size-5" />
              </Button>
              <p className="typography-small leading-relaxed text-muted-foreground">{t('mobile.connect.welcome.scanHint')}</p>
            </div>
          )}
        </ScrollableOverlay>
      </MobileResizableSheet>
    </>
  );
}
