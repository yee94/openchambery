import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { WORK_STATUS_PANEL_WIDTH } from './useWorkStatusVisibility';
import { WorkStatusCompact } from './WorkStatusCompact';

type Props = {
  sessionId: string | null;
  directory: string | null;
  visible: boolean;
  overlay?: boolean;
};

const PANEL_TRANSITION_MS = 200;

export const WorkStatusPanel: React.FC<Props> = ({ sessionId, directory, visible, overlay = false }) => {
  const { t } = useI18n();
  const setOverlayOpen = useUIStore((state) => state.setWorkStatusOverlayOpen);
  const overlayRef = React.useRef<HTMLElement | null>(null);
  const [contentMounted, setContentMounted] = React.useState(visible);

  React.useEffect(() => {
    if (visible) {
      setContentMounted(true);
      return undefined;
    }
    const timer = window.setTimeout(() => setContentMounted(false), PANEL_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);

  React.useEffect(() => {
    if (!overlay || !visible) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (overlayRef.current?.contains(target)) return;
      if (target?.closest('[data-work-status-toggle]')) return;
      setOverlayOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOverlayOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [overlay, setOverlayOpen, visible]);

  return (
    <aside
      ref={overlayRef}
      aria-label={t('chat.workStatus.ariaLabel')}
      aria-hidden={!visible}
      inert={!visible}
      className={cn(
        'relative my-2 flex max-h-[calc(100%-1rem)] shrink-0 flex-col self-start overflow-x-hidden overflow-y-auto bg-transparent',
        overlay && 'absolute right-3 top-3 z-30 my-0 max-h-[calc(100%-1.5rem)] rounded-lg bg-[var(--surface-elevated)]/95 px-1 backdrop-blur-md',
        !overlay && (visible ? 'mr-3' : 'mr-0'),
      )}
      style={{
        width: overlay || visible ? WORK_STATUS_PANEL_WIDTH : 0,
        opacity: visible ? 1 : 0,
        transform: visible ? 'none' : overlay ? 'translateY(-6px)' : 'translateX(24px)',
        transitionProperty: 'width, opacity, transform, margin',
        transitionDuration: `${PANEL_TRANSITION_MS}ms`,
        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
        pointerEvents: visible ? undefined : 'none',
      }}
    >
      {contentMounted ? <WorkStatusCompact sessionId={sessionId} directory={directory} /> : null}
    </aside>
  );
};
