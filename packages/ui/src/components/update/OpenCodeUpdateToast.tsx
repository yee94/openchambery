import * as React from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import {
  buildOpenCodeUpgradeRequestBody,
  resolveOpenCodeUpdateVersion,
  resolveOpenCodeUpgradeStatusVersion,
  shouldShowOpenCodeUpdateToast,
} from './openCodeUpdateDedup';
import { scheduleOpenCodeUpdateInitialCheck } from './openCodeUpdateInitialCheck';
import { openCodeUpdateQueryOptions } from './openCodeUpdateQuery';

const UPDATE_TOAST_ID = 'opencode-update-available';
const UPGRADE_TOAST_ID = 'opencode-upgrade-progress';
const UPDATE_TOAST_DISMISSED_VERSION_KEY = 'opencode-update-toast-dismissed-version';

export const OpenCodeUpdateToast: React.FC = () => {
  const { t } = useI18n();
  const showOpenCodeUpdateNotifications = useUIStore((state) => state.showOpenCodeUpdateNotifications);
  const seenVersionsRef = React.useRef(new Set<string>());
  const upgradingRef = React.useRef(false);
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const queryClient = useQueryClient();
  const [checkEnabled, setCheckEnabled] = React.useState(false);
  React.useEffect(() => scheduleOpenCodeUpdateInitialCheck(showOpenCodeUpdateNotifications, async () => {
    setCheckEnabled(true);
  }), [showOpenCodeUpdateNotifications]);
  const update = useQuery({ ...openCodeUpdateQueryOptions(transport, generation), enabled: showOpenCodeUpdateNotifications && checkEnabled });
  useEventListener('openchamber:opencode-update-available', (event: Event) => {
    if (showOpenCodeUpdateNotifications && resolveOpenCodeUpdateVersion((event as CustomEvent<unknown>).detail)) void update.refetch();
  });
  const dismissedKey = `${UPDATE_TOAST_DISMISSED_VERSION_KEY}:${transport}`;
  React.useEffect(() => {
    seenVersionsRef.current.clear();
    toast.dismiss(UPDATE_TOAST_ID);
    toast.dismiss(UPGRADE_TOAST_ID);
  }, [transport, generation]);

  React.useEffect(() => {
    if (!showOpenCodeUpdateNotifications) {
      toast.dismiss(UPDATE_TOAST_ID);
    }
  }, [showOpenCodeUpdateNotifications]);

  const runUpgrade = useEvent(async (version: string, confirmActiveTasks = false) => {
    if (upgradingRef.current) return;
    upgradingRef.current = true;
    const current = () => transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration();
    toast.dismiss(UPDATE_TOAST_ID);
    toast.message(t('opencodeUpdate.toast.upgrading.title'), {
      id: UPGRADE_TOAST_ID,
      description: t('opencodeUpdate.toast.upgrading.description'),
      duration: Infinity,
      icon: <Icon name="refresh" className="h-4 w-4 animate-spin text-muted-foreground" />,
    });

    try {
      const body = buildOpenCodeUpgradeRequestBody(version);
      if (!body) {
        throw new Error(t('opencodeUpdate.toast.failed.description'));
      }
      const response = await runtimeFetch('/api/opencode/upgrade', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ ...body, confirmActiveTasks }),
      });
      const payload = await response.json().catch(() => null) as null | { success?: boolean; version?: string; error?: string; errorCode?: string };
      if (!current()) return;
      if (payload?.errorCode === 'UPGRADE_ACTIVE_TASKS') {
        toast.error(t('opencodeUpdate.toast.failed.title'), {
          id: UPGRADE_TOAST_ID,
          description: payload.error,
          duration: Infinity,
          action: { label: t('opencodeUpdate.toast.actions.update'), onClick: () => {
            if (current()) void runUpgrade(version, true);
          } },
        });
        return;
      }
      if (!response.ok || payload?.success !== true) {
        throw new Error(payload?.error || response.statusText || t('opencodeUpdate.toast.failed.description'));
      }

      toast.success(t('opencodeUpdate.toast.updated.title'), {
        id: UPGRADE_TOAST_ID,
        description: payload?.version
          ? t('opencodeUpdate.toast.updated.descriptionWithVersion', { version: payload.version })
          : t('opencodeUpdate.toast.updated.description'),
        duration: Infinity,
        icon: <Icon name="check" className="h-4 w-4 text-[var(--status-success)]" />,
      });
      void queryClient.invalidateQueries({ queryKey: [transport, 'opencode-update', generation] });
      void queryClient.invalidateQueries({ queryKey: [transport, 'about', generation] });
    } catch (error) {
      if (!current()) return;
      toast.error(t('opencodeUpdate.toast.failed.title'), {
        id: UPGRADE_TOAST_ID,
        description: error instanceof Error ? error.message : t('opencodeUpdate.toast.failed.description'),
        duration: Infinity,
        action: { label: t('opencodeUpdate.toast.actions.update'), onClick: () => {
          if (current()) void runUpgrade(version);
        } },
      });
    } finally {
      upgradingRef.current = false;
    }
  });

  React.useEffect(() => {
    const showUpdateAvailableToast = (version: string) => {
      // Upstream setting wins over our dedup logic: if user disabled
      // OpenCode update notifications, dismiss any active toast and bail
      // before consulting dedup state.
      if (!useUIStore.getState().showOpenCodeUpdateNotifications) {
        toast.dismiss(UPDATE_TOAST_ID);
        return;
      }
      const decision = shouldShowOpenCodeUpdateToast({
        version,
        dismissedVersion: getDeferredSafeStorage().getItem(dismissedKey),
        seenVersions: seenVersionsRef.current,
      });
      if (!decision) {
        return;
      }
      seenVersionsRef.current.add(version);

      toast.info(t('opencodeUpdate.toast.available.title'), {
        id: UPDATE_TOAST_ID,
        description: t('opencodeUpdate.toast.available.description', { version }),
        duration: Infinity,
        action: {
          label: t('opencodeUpdate.toast.actions.update'),
          onClick: () => {
            if (transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration()) void runUpgrade(version);
          },
        },
        cancel: {
          label: t('opencodeUpdate.toast.actions.dismiss'),
          onClick: () => {
            getDeferredSafeStorage().setItem(dismissedKey, version);
            toast.dismiss(UPDATE_TOAST_ID);
          },
        },
      });
    };

    const version = resolveOpenCodeUpgradeStatusVersion(update.data);
    if (version) showUpdateAvailableToast(version);
    else if (update.data?.available === false || update.data?.canManage === false) toast.dismiss(UPDATE_TOAST_ID);
  }, [showOpenCodeUpdateNotifications, t, update.data, dismissedKey, transport, generation, runUpgrade]);

  return null;
};
