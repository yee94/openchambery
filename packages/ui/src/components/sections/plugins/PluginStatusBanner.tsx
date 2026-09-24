import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { usePluginsStore } from '@/stores/usePluginsStore';
import type { PluginRuntimeTarget } from './pluginLoadState';
import { usePluginPackageUpdate, usePluginRuntimeStatus } from './usePluginRuntimeStatus';

interface PluginStatusBannerProps {
  target: PluginRuntimeTarget | null;
  /** How the plugin is named in toasts. */
  name: string;
}

/** What OpenCode reports for the selected plugin, plus an in-place update that does not rewrite config. */
export const PluginStatusBanner: React.FC<PluginStatusBannerProps> = ({ target, name }) => {
  const { t } = useI18n();
  const { status, retry, isRefreshing } = usePluginRuntimeStatus(target);
  const packageUpdate = usePluginPackageUpdate(target);
  const updatePackage = usePluginsStore((state) => state.updatePackage);
  const packageTarget = status.kind === 'known' && status.target.kind === 'package' ? status.target.target : null;
  const isUpdating = status.kind === 'known' && (status.update === 'updating' || packageUpdate?.kind === 'running');

  const handleRetry = useEvent(() => {
    retry();
  });

  const handleUpdate = useEvent(async () => {
    if (!packageTarget) return;
    const ok = await updatePackage(packageTarget);
    if (ok) toast.success(t('settings.plugins.update.toast.done', { name }));
    else toast.error(t('settings.plugins.update.toast.failed', { name }));
  });

  if (status.kind === 'loading') return null;

  if (status.kind === 'unknown') {
    return (
      <div className="flex flex-wrap items-start gap-3 rounded-md border border-border bg-card p-3" role="status" data-plugin-load-state="unknown">
        <Icon name="question" className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="typography-label text-foreground">{t('settings.plugins.status.unknown.title')}</p>
          <p className="typography-micro mt-0.5 text-muted-foreground">
            {t('settings.plugins.status.unknown.description')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRetry} disabled={isRefreshing}>
          {t('settings.plugins.status.retry')}
        </Button>
      </div>
    );
  }

  const { load, update } = status;
  const showUpdate = packageTarget !== null && (update !== 'none' || packageUpdate !== null);

  const loadBlock = (() => {
    switch (load.kind) {
      case 'active':
        return (
          <p className="typography-meta flex items-center gap-1.5 text-muted-foreground" role="status" data-plugin-load-state="active">
            <Icon name="checkbox-circle" className="h-4 w-4 text-[var(--status-success)]" />
            {load.version
              ? t('settings.plugins.status.loadedVersion', { version: load.version })
              : t('settings.plugins.status.loaded')}
          </p>
        );
      case 'notReported':
        return (
          <div className="flex flex-wrap items-start gap-3 rounded-md border border-border bg-card p-3" role="status" data-plugin-load-state="notReported">
            <Icon name="time" className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="typography-label text-foreground">{t('settings.plugins.status.notReported.title')}</p>
              <p className="typography-micro mt-0.5 text-muted-foreground">
                {t('settings.plugins.status.notReported.description')}
              </p>
            </div>
          </div>
        );
      case 'failed':
        return (
          <div className="flex flex-wrap items-start gap-3 rounded-md border border-border bg-card p-3" role="alert" data-plugin-load-state="failed">
            <Icon name="error-warning" className="mt-0.5 h-5 w-5 shrink-0 text-[var(--status-error)]" />
            <div className="min-w-0 flex-1">
              <p className="typography-label text-[var(--status-error)]">{t('settings.plugins.status.failed.title')}</p>
              <p className="typography-micro mt-1 whitespace-pre-wrap break-words font-mono text-foreground">
                {load.error}
              </p>
              {load.ref ? (
                <p className="typography-micro mt-1 text-muted-foreground">
                  {t('settings.plugins.status.failed.ref', { ref: load.ref })}
                </p>
              ) : null}
            </div>
          </div>
        );
    }
  })();

  return (
    <div className="flex flex-col gap-3">
      {loadBlock}
      {showUpdate ? (
        <div className="flex flex-wrap items-start gap-3 rounded-md border border-border bg-card p-3">
          <Icon name="arrow-up" className="mt-0.5 h-5 w-5 shrink-0 text-[var(--status-success)]" />
          <div className="min-w-0 flex-1">
            <p className="typography-label text-[var(--status-success)]">
              {t('settings.plugins.update.available.title')}
            </p>
            <p className="typography-micro mt-0.5 text-muted-foreground">
              {t('settings.plugins.update.available.description')}
            </p>
            {packageUpdate?.kind === 'failed' ? (
              <div className="mt-2" role="alert">
                <p className="typography-micro text-[var(--status-error)]">
                  {t('settings.plugins.update.failed.title')}
                </p>
                <p className="typography-micro mt-0.5 whitespace-pre-wrap break-words font-mono text-foreground">
                  {packageUpdate.error}
                </p>
              </div>
            ) : null}
          </div>
          <Button variant="default" size="sm" onClick={() => void handleUpdate()} disabled={isUpdating}>
            {isUpdating ? (
              <>
                <Icon name="loader-4" className="size-4 animate-spin" />
                {t('settings.plugins.update.running')}
              </>
            ) : (
              t('settings.plugins.update.action')
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
