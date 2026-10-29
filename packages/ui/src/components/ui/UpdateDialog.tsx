import React, { useEffect, useState } from 'react';
import { useEvent } from '@reactuses/core';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { ensureHostUpdateSnapshot, refreshHostUpdateSnapshot, startHostUpdate } from '@/queries/hostUpdateQueries';
import type { UpdateInfo, UpdateProgress } from '@/lib/desktop';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { UpdateDialogView, type UpdateDialogModel } from './UpdateDialogView';

type WebUpdateState = 'idle' | 'updating' | 'restarting' | 'reconnecting' | 'error';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  info: UpdateInfo | null;
  downloading: boolean;
  downloaded: boolean;
  progress: UpdateProgress | null;
  error: string | null;
  onDownload: () => void;
  onRestart: () => void;
  /** Runtime type to show different UI for desktop vs web */
  runtimeType?: 'desktop' | 'web' | 'vscode' | 'mobile' | null;
}

const GITHUB_RELEASES_URL = 'https://github.com/yee94/yuri/releases';
type InstallWebUpdateResult = { success: boolean; error?: string; autoRestart?: boolean };
const WEB_UPDATE_POLL_INTERVAL_MS = 2000;
const WEB_UPDATE_MAX_WAIT_MS = 10 * 60 * 1000;
type UpdateScope = { transport: string; generation: number };
const isCurrentUpdateScope = (scope: UpdateScope) => scope.transport === getRuntimeTransportIdentity() && scope.generation === getRuntimeGeneration();

async function installWebUpdate(version: string | undefined, scope: UpdateScope): Promise<InstallWebUpdateResult> {
  try {
    if (!isCurrentUpdateScope(scope)) return { success: false };
    const plan = await ensureHostUpdateSnapshot(scope.transport, scope.generation);
    if (!isCurrentUpdateScope(scope) || !version || !plan.supported || plan.update?.version !== version || plan.update.rollback) return { success: false };
    await startHostUpdate(plan, scope.transport, scope.generation);
    return { success: true, autoRestart: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : undefined };
  }
}

async function waitForUpdateApplied(
  targetVersion: string | undefined,
  scope: UpdateScope,
  maxAttempts = Math.ceil(WEB_UPDATE_MAX_WAIT_MS / WEB_UPDATE_POLL_INTERVAL_MS),
  intervalMs = WEB_UPDATE_POLL_INTERVAL_MS,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (!isCurrentUpdateScope(scope)) return false;
    try {
      const data = await refreshHostUpdateSnapshot(scope.transport, scope.generation);
      if (data.operation?.status === 'failed') return false;
      if (data.currentVersion === targetVersion && data.operation?.status === 'succeeded' && isCurrentUpdateScope(scope)) return true;
    } catch {
      // Server may be restarting
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** Adapts the existing client updater lifecycle to the shared presentation. */
export const UpdateDialog: React.FC<UpdateDialogProps> = ({
  open, onOpenChange, info, downloading, downloaded, progress, error, onDownload, onRestart, runtimeType = 'desktop',
}) => {
  const { t } = useI18n();
  const [webUpdateState, setWebUpdateState] = useState<WebUpdateState>('idle');
  const [webError, setWebError] = useState<string | null>(null);
  const otaDownloadSkipped = useUpdateStore((state) => state.otaDownloadSkipped);
  const releaseUrl = info?.releaseUrl || (info?.version ? `${GITHUB_RELEASES_URL}/tag/v${info.version}` : GITHUB_RELEASES_URL);
  // Mobile follows the check protocol: only open a URL the decision provided.
  const protocolExternalUrl = info?.downloadUrl;
  const isWebRuntime = runtimeType === 'web';
  const isMobileRuntime = runtimeType === 'mobile';
  const showProtocolExternalLink = isMobileRuntime && info?.manualUpdate === true && Boolean(protocolExternalUrl);
  const isInAppMobileOta = isMobileRuntime && info?.inAppApply === true;
  const isManualDesktopUpdate = runtimeType === 'desktop' && info?.manualUpdate === true;
  const isWebUpdating = webUpdateState !== 'idle' && webUpdateState !== 'error';
  const releaseLinkUrl = isMobileRuntime ? protocolExternalUrl : releaseUrl;
  const handleDialogOpenChange = useEvent((nextOpen: boolean) => {
    if (!nextOpen && isInAppMobileOta && downloaded) useUpdateStore.getState().dismiss();
    onOpenChange(nextOpen);
  });
  // Reset state when dialog closes
  useEffect(() => {
    if (!open) { setWebUpdateState('idle'); setWebError(null); }
  }, [open]);
  const handleWebUpdate = useEvent(async () => {
    const scope = { transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() };
    setWebUpdateState('updating'); setWebError(null);
    const result = await installWebUpdate(info?.version, scope);
    if (!isCurrentUpdateScope(scope)) return;
    if (!result.success) {
      setWebUpdateState('error'); setWebError(result.error || t('updateDialog.error.updateFailed')); return;
    }
    if (result.autoRestart) {
      setWebUpdateState('restarting');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    setWebUpdateState('reconnecting');
    const applied = await waitForUpdateApplied(info?.version, scope);
    if (!isCurrentUpdateScope(scope)) return;
    if (applied) window.location.reload();
    else { setWebUpdateState('error'); setWebError(t('updateDialog.error.takingLonger')); }
  });
  const handleAction = useEvent((id: string) => {
    switch (id) {
      case 'download':
        onDownload();
        if (runtimeType === 'desktop') onOpenChange(false);
        break;
      case 'restart': onRestart(); break;
      case 'later': useUpdateStore.getState().dismiss(); onOpenChange(false); break;
      case 'open-external': {
        const url = isMobileRuntime ? protocolExternalUrl : releaseUrl;
        if (url) void openExternalUrl(url);
        break;
      }
      case 'web-update': void handleWebUpdate(); break;
    }
  });
  const actions: UpdateDialogModel['actions'] = [];
  // Desktop / in-app mobile OTA buttons
  if (!isWebRuntime && (!isMobileRuntime || isInAppMobileOta)) {
    if (!isManualDesktopUpdate && !downloaded && !downloading) actions.push({ id: 'download', icon: 'download', label: isInAppMobileOta ? t('updateDialog.actions.applyOtaNow') : t('updateDialog.actions.downloadUpdate') });
    if (isManualDesktopUpdate && !downloaded && !downloading) actions.push({ id: 'open-external', icon: 'external-link', label: t('updateDialog.actions.openMobileUpdate') });
    if (downloading) actions.push({ id: 'downloading', icon: 'loader', loading: true, disabled: true, label: t('updateDialog.status.downloading') });
    if (downloaded) {
      if (isInAppMobileOta) actions.push({ id: 'later', variant: 'ghost', label: t('updateDialog.actions.later') });
      actions.push({ id: 'restart', icon: 'restart', label: t('updateDialog.actions.restartToUpdate') });
    }
  }
  if (isMobileRuntime && !isInAppMobileOta && showProtocolExternalLink) actions.push({ id: 'open-external', icon: 'external-link', label: t('updateDialog.actions.openMobileUpdate') });
  if (isWebRuntime) actions.push(isWebUpdating
    ? { id: 'updating', icon: 'loader', loading: true, disabled: true, label: t('updateDialog.status.updating') }
    : { id: 'web-update', icon: 'download', label: t('updateDialog.actions.updateNow') });

  const model: UpdateDialogModel = {
    title: webUpdateState === 'restarting' || webUpdateState === 'reconnecting' ? t('updateDialog.header.updating') : t('updateDialog.header.updateAvailable'),
    currentVersion: info?.currentVersion, version: info?.version, body: info?.body,
    hideChangelog: isWebUpdating, dismissible: !isWebUpdating,
    error: error || webError,
    fallbackCommand: isWebRuntime && webUpdateState === 'error' ? info?.updateCommand || 'yuri update' : undefined,
    notice: isInAppMobileOta && downloaded && otaDownloadSkipped ? t('updateDialog.status.otaBundleReused') : undefined,
    releaseLink: (!isMobileRuntime || showProtocolExternalLink) && releaseLinkUrl ? { url: releaseLinkUrl, label: 'GitHub' } : undefined,
    actions,
  };
  if (isWebRuntime && isWebUpdating) model.status = {
    kind: 'activity', label: webUpdateState === 'updating' ? t('updateDialog.status.installingUpdate')
      : webUpdateState === 'restarting' ? t('updateDialog.status.serverRestarting') : t('updateDialog.status.waitingForServer'),
    detail: t('updateDialog.status.autoReloadHint'),
  };
  if (!isWebRuntime && (!isMobileRuntime || isInAppMobileOta) && downloading) model.status = {
    kind: 'download', label: t('updateDialog.status.downloadingPayload'),
    progress: progress?.total ? Math.round(progress.downloaded / progress.total * 100) : 0,
  };
  return <UpdateDialogView open={open} onOpenChange={handleDialogOpenChange} model={model} onAction={handleAction} />;
};
