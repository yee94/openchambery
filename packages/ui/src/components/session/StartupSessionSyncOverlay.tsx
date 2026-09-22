import React from 'react';

import { getBootstrapMessages } from '@/lib/i18n/bootstrap';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

export const StartupSessionSyncOverlay: React.FC = () => {
  const active = useGlobalSessionsStore((state) => state.startupSyncProgress.active);
  const phase = useGlobalSessionsStore((state) => state.startupSyncProgress.phase);
  const completed = useGlobalSessionsStore((state) => state.startupSyncProgress.completed);
  const total = useGlobalSessionsStore((state) => state.startupSyncProgress.total);
  const { locale, t } = useI18n();
  const [openCodeStarting, setOpenCodeStarting] = React.useState(true);
  const startingLabel = getBootstrapMessages(locale).startingApi;

  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await runtimeFetch('/health', { signal: AbortSignal.timeout(4000) });
        const data = await response.json().catch(() => null) as {
          openCodeStarting?: unknown;
          isOpenCodeReady?: unknown;
          lastOpenCodeError?: unknown;
        } | null;
        if (cancelled) return;
        const starting = data?.openCodeStarting === true
          || (data?.isOpenCodeReady !== true && !data?.lastOpenCodeError);
        setOpenCodeStarting(starting);
      } catch {
        if (!cancelled) setOpenCodeStarting(true);
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 750);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const progressLabel = phase === 'restoring'
    ? t('common.loading')
    : t('sessions.startupSync.progress', { completed, total });

  React.useLayoutEffect(() => {
    const container = document.getElementById('startup-session-progress');
    const track = document.getElementById('startup-session-progress-track');
    const fill = document.getElementById('startup-session-progress-fill');
    const text = document.getElementById('startup-session-progress-text');
    if (!container || !track || !fill || !text) return;

    if (active) {
      container.hidden = false;
      fill.style.width = `${percentage}%`;
      track.setAttribute('aria-label', t('sessions.startupSync.title'));
      track.setAttribute('aria-valuemax', String(Math.max(total, 1)));
      track.setAttribute('aria-valuenow', String(completed));
      track.setAttribute('aria-valuetext', progressLabel);
      text.textContent = progressLabel;
      return;
    }

    if (openCodeStarting) {
      container.hidden = false;
      fill.style.width = '30%';
      track.setAttribute('aria-label', startingLabel);
      track.setAttribute('aria-valuetext', startingLabel);
      text.textContent = startingLabel;
      return;
    }

    container.hidden = true;
  }, [active, completed, openCodeStarting, percentage, progressLabel, startingLabel, t, total]);

  return null;
};
