import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import {
  createMobileLongPressController,
  type MobileLongPressController,
} from '@/components/ui/mobileLongPress';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type MobileProjectTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export type MobileProjectCardModel = {
  id: string;
  name: string;
  path: string;
  icon?: IconName;
  tone?: MobileProjectTone;
  sessionCount: number;
  activityLabel?: string;
  active?: boolean;
};

export type MobileProjectCardProps = {
  project: MobileProjectCardModel;
  expanded: boolean;
  onToggle: (project: MobileProjectCardModel) => void;
  onOpenActions: (project: MobileProjectCardModel) => void;
  className?: string;
};

const TONE_STYLES: Record<MobileProjectTone, React.CSSProperties | undefined> = {
  neutral: undefined,
  info: { color: 'var(--status-info)', backgroundColor: 'var(--status-info-background)' },
  success: { color: 'var(--status-success)', backgroundColor: 'var(--status-success-background)' },
  warning: { color: 'var(--status-warning)', backgroundColor: 'var(--status-warning-background)' },
  error: { color: 'var(--status-error)', backgroundColor: 'var(--status-error-background)' },
};

export function MobileProjectCard({
  project,
  expanded,
  onToggle,
  onOpenActions,
  className,
}: MobileProjectCardProps) {
  const { t } = useI18n();
  const [pressed, setPressed] = React.useState(false);
  const longPressRef = React.useRef<MobileLongPressController | null>(null);

  if (!longPressRef.current) {
    longPressRef.current = createMobileLongPressController({
      onPressedKeyChange: (key) => setPressed(key === project.id),
    });
  }

  React.useEffect(() => () => longPressRef.current?.reset(), []);

  const handleToggle = useEvent(() => {
    if (longPressRef.current?.consumeClick(project.id)) return;
    onToggle(project);
  });
  const handleOpenActions = useEvent(() => onOpenActions(project));
  const handlePointerDown = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    if ((event.pointerType !== 'touch' && event.pointerType !== 'pen') || event.button !== 0) return;
    longPressRef.current?.start({
      pointerId: event.pointerId,
      key: project.id,
      clientX: event.clientX,
      clientY: event.clientY,
      onTrigger: () => {
        setPressed(false);
        onOpenActions(project);
      },
    });
  });
  const handlePointerMove = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    longPressRef.current?.move(event.pointerId, event.clientX, event.clientY);
  });
  const handlePointerUp = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    longPressRef.current?.end(event.pointerId);
  });
  const handlePointerCancel = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    longPressRef.current?.cancel(event.pointerId);
  });
  const handleContextMenu = useEvent((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    longPressRef.current?.openFromContextMenu(project.id, () => {
      setPressed(false);
      onOpenActions(project);
    });
  });

  const countLabel = project.sessionCount === 1
    ? t('mobile.sessions.project.sessionsSingle')
    : t('mobile.sessions.project.sessionsPlural', { count: project.sessionCount });

  return (
    <article
      className={cn(
        'relative flex min-h-[88px] items-stretch overflow-hidden rounded-[24px] border border-[var(--interactive-border)] bg-[color:color-mix(in_srgb,var(--surface-elevated)_90%,transparent)] shadow-[0_14px_36px_color-mix(in_srgb,var(--surface-foreground)_8%,transparent)] backdrop-blur-xl supports-[corner-shape:squircle]:rounded-[56px]',
        project.active && 'ring-2 ring-[var(--interactive-selection)] ring-offset-2 ring-offset-[var(--surface-background)]',
        pressed && 'bg-[var(--interactive-active)]',
        className,
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3.5 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
        aria-expanded={expanded}
        onClick={handleToggle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={handleContextMenu}
        style={{ touchAction: 'pan-y' }}
      >
        <span
          className="flex size-12 shrink-0 items-center justify-center rounded-[17px] bg-[var(--surface-muted)] text-muted-foreground supports-[corner-shape:squircle]:rounded-[38px]"
          style={TONE_STYLES[project.tone ?? 'neutral']}
          aria-hidden
        >
          <Icon name={project.icon ?? 'folder-open'} className="size-5" />
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate typography-ui-label font-semibold tracking-[-0.01em]">{project.name}</span>
            {project.active ? <span className="size-1.5 shrink-0 rounded-full bg-[var(--status-success)]" aria-label={t('mobile.sessions.activeProjectAria')} /> : null}
          </span>
          <span className="truncate typography-micro text-muted-foreground">{project.path}</span>
          <span className="flex items-center gap-2 typography-micro text-muted-foreground">
            <span>{countLabel}</span>
            {project.activityLabel ? (
              <>
                <span className="size-0.5 rounded-full bg-[var(--surface-mutedForeground)]" aria-hidden />
                <span className="truncate">{project.activityLabel}</span>
              </>
            ) : null}
          </span>
        </span>

        <Icon
          name="arrow-down-s"
          className={cn('size-5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none', expanded ? 'rotate-0' : '-rotate-90')}
        />
      </button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="mr-2 min-h-11 min-w-11 self-center rounded-full text-muted-foreground"
        aria-label={t('sessions.sidebar.project.actions.projectMenu')}
        onClick={handleOpenActions}
      >
        <Icon name="more-2" className="size-5" />
      </Button>
    </article>
  );
}
