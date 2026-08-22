import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui/toast';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { useI18n } from '@/lib/i18n';
import { isCapacitorApp } from '@/lib/platform';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import {
  shouldRunMobileOtaStartupCheck,
  shouldShowMobileOtaUpdateNotice,
} from './mobileOtaUpdateNoticeDecision';

const TOAST_ID = 'mobile-ota-update-available';
const DISMISSED_VERSION_KEY = 'mobile-ota-update-toast-dismissed-version';

export const MobileOtaUpdateNotice: React.FC = () => {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const checkedRef = React.useRef(false);
  const seenVersionsRef = React.useRef(new Set<string>());
  const isNativeMobileApp = React.useMemo(() => isCapacitorApp(), []);

  const available = useUpdateStore((state) => state.available);
  const runtimeType = useUpdateStore((state) => state.runtimeType);
  const info = useUpdateStore((state) => state.info);
  const downloading = useUpdateStore((state) => state.downloading);
  const downloaded = useUpdateStore((state) => state.downloaded);
  const progress = useUpdateStore((state) => state.progress);
  const error = useUpdateStore((state) => state.error);
  const downloadUpdate = useUpdateStore((state) => state.downloadUpdate);
  const restartToUpdate = useUpdateStore((state) => state.restartToUpdate);

  const version = info?.version;
  const inAppApply = info?.inAppApply === true;

  React.useEffect(() => {
    if (
      !shouldRunMobileOtaStartupCheck({
        enabled: isNativeMobileApp,
        alreadyChecked: checkedRef.current,
      })
    ) {
      return;
    }
    checkedRef.current = true;
    void useUpdateStore.getState().checkForUpdates().catch(() => undefined);
  }, [isNativeMobileApp]);

  const openUpdateDialog = useEvent(() => {
    setDialogOpen(true);
  });

  const dismissNotice = useEvent((dismissedVersion: string) => {
    getDeferredSafeStorage().setItem(DISMISSED_VERSION_KEY, dismissedVersion);
    toast.dismiss(TOAST_ID);
  });

  React.useEffect(() => {
    const decision = shouldShowMobileOtaUpdateNotice({
      enabled: isNativeMobileApp,
      runtimeType,
      available,
      inAppApply,
      version: version ?? '',
      dismissedVersion: getDeferredSafeStorage().getItem(DISMISSED_VERSION_KEY),
      seenVersions: seenVersionsRef.current,
    });

    if (!decision || !version) {
      if (!available || !inAppApply || runtimeType !== 'mobile') {
        toast.dismiss(TOAST_ID);
      }
      return;
    }

    seenVersionsRef.current.add(version);

    toast.info(t('mobileUpdate.ota.toast.available.title'), {
      id: TOAST_ID,
      description: t('mobileUpdate.ota.toast.available.description', { version }),
      duration: Infinity,
      icon: <Icon name="refresh" className="h-4 w-4 text-muted-foreground" />,
      action: {
        label: t('mobileUpdate.ota.toast.actions.update'),
        onClick: openUpdateDialog,
      },
      cancel: {
        label: t('mobileUpdate.ota.toast.actions.dismiss'),
        onClick: () => {
          dismissNotice(version);
        },
      },
    });
  }, [available, inAppApply, isNativeMobileApp, openUpdateDialog, dismissNotice, runtimeType, t, version]);

  if (!isNativeMobileApp) {
    return null;
  }

  return (
    <UpdateDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      info={info}
      downloading={downloading}
      downloaded={downloaded}
      progress={progress}
      error={error}
      onDownload={downloadUpdate}
      onRestart={restartToUpdate}
      runtimeType={runtimeType}
    />
  );
};
