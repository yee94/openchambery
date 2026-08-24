import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { getClientPlatform } from '@/lib/platform';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { openMobileAppUpdateDownload } from './mobileAppUpdateDownload';

const TOAST_ID = 'mobile-app-update-available';
const DISMISSED_VERSION_KEY = 'mobile-app-update-toast-dismissed-version';

export const MobileAppUpdateToast: React.FC = () => {
  const { t } = useI18n();
  const available = useUpdateStore((state) => state.available);
  const runtimeType = useUpdateStore((state) => state.runtimeType);
  const version = useUpdateStore((state) => state.info?.version);
  const downloadUrl = useUpdateStore((state) => state.info?.downloadUrl);
  const inAppApply = useUpdateStore((state) => state.info?.inAppApply === true);
  const seenVersionsRef = React.useRef(new Set<string>());

  React.useEffect(() => {
    // In-app web-bundle OTA is applied from About / UpdateDialog, not the
    // Android APK download toast.
    if (
      getClientPlatform() !== 'android'
      || runtimeType !== 'mobile'
      || !available
      || !version
      || !downloadUrl
      || inAppApply
    ) {
      toast.dismiss(TOAST_ID);
      return;
    }

    if (getDeferredSafeStorage().getItem(DISMISSED_VERSION_KEY) === version) {
      return;
    }

    if (seenVersionsRef.current.has(version)) {
      return;
    }

    seenVersionsRef.current.add(version);

    toast.info(t('mobileUpdate.toast.available.title'), {
      id: TOAST_ID,
      description: t('mobileUpdate.toast.available.description', { version }),
      duration: Infinity,
      icon: <Icon name="download" className="h-4 w-4 text-muted-foreground" />,
      action: {
        label: t('mobileUpdate.toast.actions.download'),
        onClick: () => {
          void openMobileAppUpdateDownload(downloadUrl);
        },
      },
      cancel: {
        label: t('mobileUpdate.toast.actions.dismiss'),
        onClick: () => {
          getDeferredSafeStorage().setItem(DISMISSED_VERSION_KEY, version);
          toast.dismiss(TOAST_ID);
        },
      },
    });
  }, [available, downloadUrl, inAppApply, runtimeType, t, version]);

  return null;
};
