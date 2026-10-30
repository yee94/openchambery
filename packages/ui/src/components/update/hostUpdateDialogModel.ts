import type { UpdateDialogModel } from '@/components/ui/UpdateDialogView';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { isHostUpdateActive, type HostUpdateOperation, type HostUpdateSnapshot } from '@/queries/hostUpdateQueries';

type HostDialogState = {
  versionFallback: string;
  checking: 'initial' | 'refresh' | false;
  submitting: boolean;
  failure: 'unsupported' | 'check' | 'disconnected' | null;
  /** The task watched by this view reached `succeeded`. */
  completed?: boolean;
  /** Display-only metadata retained while the Host omits its active plan. */
  updateDetails?: HostUpdateSnapshot['update'];
};

/** Stage-weighted overall progress so the bar keeps moving forward across Host stages. */
function overallProgress(status: HostUpdateOperation['status'], stageProgress: number | null): number {
  if (status === 'checking') return 5;
  if (status === 'downloading') return 5 + Math.min(Math.max(stageProgress ?? 0, 0), 100) * 0.75;
  if (status === 'installing') return 85;
  if (status === 'restarting') return 95;
  return 100;
}

/** Host wire DTO → shared update presentation; no local updater/store side effects. */
export function toHostUpdateDialogModel(snapshot: HostUpdateSnapshot | undefined, state: HostDialogState, t: (key: I18nKey, params?: I18nParams) => string): UpdateDialogModel {
  const operation = snapshot?.operation;
  const update = snapshot?.update;
  const details = update ?? (operation && state.updateDetails && operation.planId === state.updateDetails.planId && operation.version === state.updateDetails.version ? state.updateDetails : undefined);
  const active = isHostUpdateActive(operation);
  const unsupported = snapshot?.supported === false || state.failure === 'unsupported';
  const model: UpdateDialogModel = {
    title: t('settings.yuri.about.hostUpdate.title'),
    stableLayout: true,
    description: t('settings.yuri.about.hostUpdate.description'),
    currentVersion: snapshot?.currentVersion ?? state.versionFallback,
    version: update?.version ?? operation?.version,
    body: details || operation ? details?.releaseNotes || t('settings.yuri.about.hostUpdate.noNotes') : undefined,
    warning: !active && update?.rollback ? t('settings.yuri.about.hostUpdate.downgrade') : undefined,
    actions: active || state.submitting || state.completed || !update ? [] : [
      { id: 'confirm', icon: 'download',
        label: t('settings.yuri.about.hostUpdate.confirm'),
        disabled: !snapshot?.supported || Boolean(state.failure) || Boolean(state.checking) },
    ],
  };
  if (active && operation) {
    model.status = {
      kind: operation.status === 'downloading' ? 'download' : 'activity',
      label: t(state.failure === 'disconnected' ? 'settings.yuri.about.hostUpdate.reconnecting' : `settings.yuri.about.hostUpdate.status.${operation.status}`),
      progress: overallProgress(operation.status, operation.progress),
    };
  } else if (state.completed && !update) {
    model.status = { kind: 'download', label: t('settings.yuri.about.hostUpdate.status.succeeded'), progress: 100 };
  } else if (state.submitting) {
    model.status = { kind: 'activity', label: t('settings.yuri.about.state.checking'), progress: 0 };
  } else if (state.checking === 'initial') {
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
