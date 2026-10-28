import React from 'react';
import { useEvent } from '@reactuses/core';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { guiPluginReadinessKey } from './readiness';
import { GuiPluginMount } from './GuiPluginMount';
import { GuiPreviewLoading } from './GuiPreviewLoading';
import { MobileWindowActiveContext } from '@/components/ui/mobile-window-active-context';

export function GuiFileLinkBridge({ path, base, active: surfaceActive = true, children }: {
  path: string;
  base?: string;
  active?: boolean;
  children?: React.ReactNode | ((view: { preview: React.ReactNode; toggle: React.ReactNode }) => React.ReactNode);
}) {
  const windowActive = React.useContext(MobileWindowActiveContext);
  const active = surfaceActive && windowActive;
  const { host, snapshot, inventory, loading, error, requested, requestLoad, refresh } = useGuiPlugins();
  const { t } = useI18n();
  const anchor = React.useRef<HTMLDivElement>(null);
  const lastAttempt = React.useRef<{ host: typeof host; key: string } | null>(null);
  const wasLoading = React.useRef(loading);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const identity = JSON.stringify([path, base, snapshot.sessionKey]);
  const [sourceIdentity, setSourceIdentity] = React.useState<string | null>(null);
  // Panel selection emits snapshots too, but must never reopen a dismissed preview.
  const readyVersion = guiPluginReadinessKey(snapshot.plugins);
  const available = snapshot.plugins.some((plugin) => plugin.status === 'active');
  const panel = active && host ? host.filePanel(path, base) : undefined;
  const preview = Boolean(panel && sourceIdentity !== identity);
  const failure = error || inventory.find((plugin) => plugin.enabled && plugin.error)?.error
    || snapshot.plugins.find((plugin) => plugin.status === 'failed')?.error;
  const preparing = active && !preview && loading && !failure && sourceIdentity !== identity;

  React.useEffect(() => {
    if (active && path && !requested && anchor.current && !anchor.current.closest('[inert], [hidden], [aria-hidden="true"]')) requestLoad();
  }, [active, path, requested, requestLoad]);

  React.useLayoutEffect(() => {
    if (!active || !host || !path || !available || anchor.current?.closest('[inert], [hidden], [aria-hidden="true"]')) return;
    return host.registerFileView(path, base);
  }, [active, host, path, base, available, snapshot.sessionKey]);
  const open = useEvent((manual: boolean) => {
    if (!host) return;
    setFeedback(null);
    try {
      const matched = host.openLink({ href: path, exact: true, base });
      if (manual && !matched) setFeedback(t('guiPlugins.noPreview'));
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : t('guiPlugins.error'));
    }
  });

  React.useEffect(() => {
    if (wasLoading.current && !loading) lastAttempt.current = null;
    wasLoading.current = loading;
    if (!active) {
      lastAttempt.current = null;
      return;
    }
    if (!host || !path || !available || !anchor.current
      || anchor.current.closest('[inert], [hidden], [aria-hidden="true"]')) return;
    const key = JSON.stringify([path, base, readyVersion, snapshot.sessionKey]);
    if (lastAttempt.current?.host === host && lastAttempt.current.key === key) return;
    lastAttempt.current = { host, key };
    open(false);
  }, [active, loading, host, path, base, readyVersion, available, snapshot.sessionKey, open]);

  const label = t(preview || preparing ? 'filesView.editor.switchToEditMode' : 'filesView.editor.switchToPreviewMode');
  const toggle = active && (panel || feedback || preparing) ? (
    <Button variant="ghost" size="icon" aria-label={label} title={label} disabled={!host && !preparing}
      onClick={() => {
        if (preview || preparing) setSourceIdentity(identity);
        else { setSourceIdentity(null); open(true); }
      }}>
      <Icon name={preview || preparing ? 'eye' : 'eye-off'} className="size-4" aria-hidden="true" />
    </Button>
  ) : null;
  const content = preview && host && panel
    ? <GuiPluginMount host={host} contributionKey={panel.key} kind="panel" revision={JSON.stringify([guiPluginReadinessKey(snapshot.plugins, panel.pluginId), snapshot.sessionKey])}
      fallback={<GuiPreviewLoading onViewSource={() => setSourceIdentity(identity)} />} />
    : preparing ? <GuiPreviewLoading onViewSource={() => setSourceIdentity(identity)} /> : null;

  return (
    <div ref={anchor} className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col" data-gui-file-view={path}>
      {feedback ? <span role="status" className="shrink-0 px-3 py-1 break-words typography-meta text-muted-foreground">{feedback}</span> : null}
      {active && !preview && failure ? <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span role="alert" className="min-w-0 flex-1 break-words typography-meta text-[var(--status-error)]">{failure}</span>
        <Button size="sm" disabled={loading} onClick={refresh}>{t('guiPlugins.refresh')}</Button>
      </div> : null}
      {typeof children === 'function' ? children({ preview: content, toggle }) : <>
        {toggle ? <div className="absolute right-3 top-3 z-30">{toggle}</div> : null}
        {content ?? children}
      </>}
    </div>
  );
}
