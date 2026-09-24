import * as React from 'react';
import { useEvent } from '@reactuses/core';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { DesktopHostSwitcherInline } from '@/components/desktop/DesktopHostSwitcher';
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import {
  fetchUpgradeScreenStatus,
  installRequiredOpenCode,
  type UpgradeScreenStatus,
} from '@/lib/opencode/upgrade-screen';

const failureText = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message.trim() ? error.message.trim() : fallback
);

export const OpenCodeUpgradeScreen: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<UpgradeScreenStatus | null>(null);
  const [checked, setChecked] = React.useState(false);
  const [operation, setOperation] = React.useState<'install' | 'reconnect' | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const titleId = React.useId();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const generation = React.useRef(0);

  React.useEffect(() => {
    let mounted = true;
    const run = async () => {
      const revision = ++generation.current;
      try {
        const next = await fetchUpgradeScreenStatus();
        if (!mounted || revision !== generation.current) return;
        setStatus(next);
        if (next.state !== 'incompatible') setFailure(null);
      } catch {
        // An unread host keeps the existing connection UI. A known incompatible
        // result is left in place so a failed recheck cannot open a broken session.
      } finally {
        if (mounted && revision === generation.current) setChecked(true);
      }
    };
    void run();
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      if (!mounted) return;
      setStatus(null);
      setChecked(false);
      setOperation(null);
      setFailure(null);
      void run();
    });
    return () => {
      mounted = false;
      generation.current += 1;
      unsubscribe();
    };
  }, []);

  const incompatible = status?.state === 'incompatible';

  React.useEffect(() => {
    if (!incompatible) return;
    document.getElementById('initial-loading')?.remove();
    headingRef.current?.focus();
  }, [incompatible]);

  const recover = useEvent(async (action: 'install' | 'reconnect') => {
    if (operation) return;
    const revision = ++generation.current;
    setOperation(action);
    setFailure(null);
    try {
      if (action === 'install') {
        const installed = await installRequiredOpenCode();
        if (revision !== generation.current) return;
        if (!installed.version) throw new Error(t('opencodeUpgrade.screen.failedGeneric'));
        window.location.reload();
        return;
      }
      const next = await fetchUpgradeScreenStatus();
      if (revision !== generation.current) return;
      if (next.state === 'incompatible') {
        setStatus(next);
        return;
      }
      if (next.state !== 'compatible') throw new Error(t('opencodeUpgrade.screen.failedGeneric'));
      window.location.reload();
    } catch (error) {
      if (revision !== generation.current) return;
      setFailure(failureText(error, t('opencodeUpgrade.screen.failedGeneric')));
    } finally {
      if (revision === generation.current) setOperation(null);
    }
  });

  if (!checked) return null;
  if (!incompatible || !status) return <>{children}</>;

  const outdated = Boolean(status.version?.startsWith('2.'));
  const descriptionKey = status.installation === 'bundled'
    ? 'opencodeUpgrade.screen.bundled'
    : status.installation === 'external'
      ? (outdated ? 'opencodeUpgrade.screen.outdatedExternal' : 'opencodeUpgrade.screen.external')
      : (outdated ? 'opencodeUpgrade.screen.outdatedLocal' : 'opencodeUpgrade.screen.local');
  const minimum = status.minimumVersion;
  const busy = operation !== null;

  return (
    <section
      className="app-region-drag flex h-full min-h-dvh min-h-0 items-center justify-center overflow-y-auto bg-background px-4 py-10 text-foreground select-none sm:px-6"
      aria-labelledby={titleId}
      aria-busy={busy}
      data-opencode-upgrade-screen="true"
    >
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <OpenChamberLogo width={48} height={48} />
        <h1
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
          className="mt-6 text-xl font-semibold tracking-tight text-balance outline-none"
        >
          {t(outdated ? 'opencodeUpgrade.screen.outdatedTitle' : 'opencodeUpgrade.screen.title')}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground text-balance">
          {t(descriptionKey, { version: status.version ?? '', minimum })}
          {status.canInstall ? <> {t('opencodeUpgrade.screen.installDescription', { minimum })}</> : null}
        </p>
        {!status.canInstall ? (
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground text-balance">
            {t('opencodeUpgrade.screen.manualGuidance')}
          </p>
        ) : null}
        {status.version ? (
          <div className="mt-5 inline-flex max-w-full items-center gap-2 rounded-md border border-border px-2.5 py-1 font-mono text-xs" aria-hidden>
            <span className="truncate text-muted-foreground">{status.version}</span>
            <Icon name="arrow-right" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-foreground">{minimum}+</span>
          </div>
        ) : null}
        {failure ? (
          <p role="alert" className="mt-5 w-full break-words rounded-md border border-[var(--status-error)]/30 bg-[var(--status-error-background)] px-3 py-2 text-left text-sm text-[var(--status-error-text)]">
            <span className="font-medium">{t('opencodeUpgrade.screen.failedTitle')}</span>
            {' '}
            {failure}
          </p>
        ) : null}
        <div className="app-region-no-drag mt-7 flex w-full flex-wrap items-center justify-center gap-2">
          {status.canInstall ? (
            <Button type="button" disabled={busy} onClick={() => void recover('install')}>
              <Icon
                name={operation === 'install' ? 'refresh' : 'download'}
                className={operation === 'install' ? 'size-4 motion-safe:animate-spin' : 'size-4'}
              />
              <span role={operation === 'install' ? 'status' : undefined}>
                {operation === 'install'
                  ? t(outdated ? 'opencodeUpgrade.screen.updating' : 'opencodeUpgrade.screen.installing')
                  : t(outdated ? 'opencodeUpgrade.screen.update' : 'opencodeUpgrade.screen.install', { minimum })}
              </span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant={status.canInstall ? 'ghost' : 'default'}
            disabled={busy}
            onClick={() => void recover('reconnect')}
          >
            <Icon name="refresh" className={operation === 'reconnect' ? 'size-4 motion-safe:animate-spin' : 'size-4'} />
            <span role={operation === 'reconnect' ? 'status' : undefined}>
              {t(operation === 'reconnect' ? 'opencodeUpgrade.screen.reconnecting' : 'opencodeUpgrade.screen.reconnect')}
            </span>
          </Button>
        </div>
        <a
          className="app-region-no-drag mt-6 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href="https://opencode.ai/download"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('opencodeUpgrade.screen.guide')}
          <Icon name="external-link" className="size-3" />
        </a>
        <div className="app-region-no-drag mt-3 w-full">
          <DesktopHostSwitcherInline />
        </div>
      </div>
    </section>
  );
};
