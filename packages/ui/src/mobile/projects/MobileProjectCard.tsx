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

import { MobileFloatingSurface } from '../MobileSurface';

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
  embedded?: boolean;
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

/** Prefer a short parent/folder segment over the full absolute path on small screens. */
const formatProjectPathHint = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= 1) return normalized;
  if (segments.length === 2) return segments[0];
  return segments.slice(-3, -1).join('/');
};

/**
 * Floating project header capsule. The project is the visual and semantic
 * parent of the workspace/session card that follows it in MobileProjectsHome.
 */
export function MobileProjectCard({
  project,
  expanded,
  embedded = false,
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
  const pathHint = formatProjectPathHint(project.path);

  const card = (
    <article
        data-mobile-press-surface="soft"
        className={cn(
          'oc-mobile-project-card relative flex items-stretch overflow-hidden rounded-[var(--oc-mobile-surface-radius)]',
          pressed && 'bg-interactive-hover',
          className,
        )}
      >
        <button
          type="button"
          data-mobile-press-surface-trigger
          data-mobile-press-feedback="none"
          className="oc-mobile-project-trigger flex min-w-0 flex-1 items-center text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
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
            className={cn(
              'oc-mobile-project-icon oc-mobile-glass-control flex shrink-0 items-center justify-center rounded-full text-muted-foreground',
            )}
            style={TONE_STYLES[project.tone ?? 'neutral']}
            aria-hidden
          >
            <Icon name={project.icon ?? 'code-box'} className="oc-mobile-project-icon-glyph" />
          </span>

          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="oc-mobile-project-title oc-mobile-entity-title truncate font-semibold text-foreground">
                {project.name}
              </span>
              {project.active ? (
                <span
                  className="size-2 shrink-0 rounded-full bg-[var(--status-success)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--status-success)_12%,transparent)]"
                  aria-label={t('mobile.sessions.activeProjectAria')}
                />
              ) : null}
            </span>
            <span className="oc-mobile-project-meta oc-mobile-entity-meta flex min-w-0 items-center text-muted-foreground">
              <span className="shrink-0 tabular-nums">{countLabel}</span>
              {project.activityLabel ? (
                <>
                  <span aria-hidden className="text-muted-foreground/50">·</span>
                  <span className="shrink-0 tabular-nums">{project.activityLabel}</span>
                </>
              ) : null}
              {pathHint ? (
                <>
                  <span aria-hidden className="text-muted-foreground/50">·</span>
                  <span className="min-w-0 truncate" title={project.path}>{pathHint}</span>
                </>
              ) : null}
            </span>
          </span>

          <Icon
            name="arrow-down-s"
            className={cn(
              'oc-mobile-project-chevron shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
              expanded ? 'rotate-0' : '-rotate-90',
            )}
          />
        </button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="oc-mobile-project-action self-center rounded-full text-muted-foreground"
          aria-label={t('sessions.sidebar.project.actions.projectMenu')}
          onClick={handleOpenActions}
        >
          <Icon name="more-2" className="size-4" />
        </Button>
    </article>
  );

  return embedded ? card : <MobileFloatingSurface asChild>{card}</MobileFloatingSurface>;
}
