import type { UpdateDialogModel } from '@/components/ui/UpdateDialogView';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { isHostUpdateActive, type HostUpdateSnapshot } from '@/queries/hostUpdateQueries';

type HostDialogState = {
  versionFallback: string;
  checking: 'initial' | 'refresh' | false;
  submitting: boolean;
  failure: 'unsupported' | 'check' | 'disconnected' | null;
};

/** Host wire DTO → shared update presentation; no local updater/store side effects. */
export function toHostUpdateDialogModel(snapshot: HostUpdateSnapshot | undefined, state: HostDialogState, t: (key: I18nKey, params?: I18nParams) => string): UpdateDialogModel {
  const operation = snapshot?.operation;
  const update = snapshot?.update;
  const active = isHostUpdateActive(operation);
  const unsupported = snapshot?.supported === false || state.failure === 'unsupported';
  const model: UpdateDialogModel = {
    title: t('settings.yuri.about.hostUpdate.title'),
    description: t('settings.yuri.about.hostUpdate.description'),
    currentVersion: snapshot?.currentVersion ?? state.versionFallback,
    version: update?.version ?? operation?.version,
    methodLabel: update ? t(`settings.yuri.about.hostUpdate.kind.${update.kind}`) : undefined,
    body: update ? update.releaseNotes || t('settings.yuri.about.hostUpdate.noNotes') : undefined,
    warning: !active && update?.rollback ? t('settings.yuri.about.hostUpdate.downgrade') : undefined,
    actions: [
      { id: 'check', variant: 'ghost', label: t('settings.yuri.about.actions.checkForUpdates'), disabled: Boolean(state.checking) },
      { id: 'confirm', icon: active || state.submitting ? 'loader' : 'download', loading: active || state.submitting,
        label: t('settings.yuri.about.hostUpdate.confirm'),
        disabled: !update || !snapshot?.supported || active || state.submitting || Boolean(state.failure) || Boolean(state.checking) },
    ],
  };
  if (active && operation) {
    model.status = {
      kind: operation.status === 'downloading' ? 'download' : 'activity',
      label: t(`settings.yuri.about.hostUpdate.status.${operation.status}`), progress: operation.progress,
      detail: state.failure === 'disconnected' ? t('settings.yuri.about.hostUpdate.reconnecting') : undefined,
    };
  } else if (state.checking === 'initial' || state.submitting) {
    model.status = { kind: 'activity', label: t('settings.yuri.about.state.checking') };
  } else if (unsupported) {
    model.message = t('settings.yuri.about.hostUpdate.unsupported');
  } else if (state.failure) {
    model.error = t(state.failure === 'disconnected' ? 'settings.yuri.about.hostUpdate.reconnecting' : 'settings.yuri.about.toast.checkFailed');
  } else if (!update && snapshot?.supported) {
    model.message = operation?.status === 'succeeded' ? t('settings.yuri.about.hostUpdate.status.succeeded') : t('settings.yuri.about.toast.latestVersion');
  }
  if (operation?.status === 'failed') model.error = t('settings.yuri.about.hostUpdate.status.failed');
  return model;
}
