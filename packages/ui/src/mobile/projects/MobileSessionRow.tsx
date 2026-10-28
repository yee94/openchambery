import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { SessionBusyIndicator } from '@/components/session/SessionBusyIndicator';
import { renderHighlightedText } from '@/components/session/sidebar/utils';
import { Button } from '@/components/ui/button';
import { MobileSwipeActionRail } from '@/components/ui/MobileSwipeActionRail';
import { useMobileSwipeActions } from '@/components/ui/useMobileSwipeActions';
import { SessionRowDragContext } from '@/components/session/sidebar/sessionDragState';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import {
  resolveMobileSessionIndicator,
  type MobileSessionIndicator,
} from './mobileSessionIndicator';

export type MobileSessionRowModel = {
  id: string;
  kind?: 'session' | 'pagination';
  title: string;
  subtitle?: string;
  /** Compact `+12 −3` from session.summary when those counts exist. */
  changes?: string;
  activityLabel?: string;
  unread?: boolean;
  pinned?: boolean;
  archived?: boolean;
  active?: boolean;
};

export type MobileSessionRowProps = {
  session: MobileSessionRowModel;
  depth?: number;
  hasChildren?: boolean;
  expanded?: boolean;
  /** Adjacent pagination affordances (more / fewer) read as one control group. */
  paginationContinues?: boolean;
  onToggleChildren?: () => void;
  onSelect: (session: MobileSessionRowModel) => void;
  onPin: (session: MobileSessionRowModel) => void;
  onArchive: (session: MobileSessionRowModel) => void;
  /** Opens the complete action sheet from the visible actions button. */
  onOpenActions: (session: MobileSessionRowModel) => void;
  indicator?: MobileSessionIndicator;
  className?: string;
  /** Substring to wrap in `<mark>` — same helper as the desktop sidebar. */
  highlightQuery?: string;
};

function MobileSessionRowImpl({
  session,
  depth = 0,
  hasChildren = false,
  expanded = false,
  paginationContinues = false,
  onToggleChildren,
  onSelect,
  onPin,
  onArchive,
  onOpenActions,
  indicator,
  className,
  highlightQuery,
}: MobileSessionRowProps) {
  const { t } = useI18n();
  const reorderDragging = React.useContext(SessionRowDragContext);
  const swipe = useMobileSwipeActions(session.id, () => onSelect(session), reorderDragging);
  const { offset, dragging, handleSelect, handlePointerDown, handlePointerMove,
    finishGesture, handlePointerCancel, handleContextMenu } = swipe;

  const handleOpenActions = useEvent(() => onOpenActions(session));
  const handleToggleChildren = useEvent(() => onToggleChildren?.());
  const pinLabel = session.pinned
    ? t('sessions.sidebar.session.menu.unpin')
    : t('sessions.sidebar.session.menu.pin');
  const resolvedIndicator = indicator ?? resolveMobileSessionIndicator({
    hasPendingQuestion: false,
    hasPendingPermission: false,
    running: false,
    unread: Boolean(session.unread),
  });
  const indicatorLabel = resolvedIndicator === 'question'
    ? t('sessions.sidebar.session.status.questionRequired')
    : resolvedIndicator === 'permission'
      ? t('sessions.sidebar.session.status.permissionRequired')
      : resolvedIndicator === 'running'
        ? t('sessions.sidebar.session.status.active')
        : resolvedIndicator === 'completed-unread'
          ? t('sessions.sidebar.session.status.unread')
          : undefined;

  if (session.kind === 'pagination') {
    return (
      <div className={cn(
        'yuri-mobile-session-row',
        paginationContinues && 'yuri-mobile-session-pagination-continues',
        className,
      )}>
        <button
          type="button"
          data-mobile-press-feedback="soft"
          className="yuri-mobile-session-pagination-row"
          style={{ touchAction: 'pan-y' }}
          onClick={handleSelect}
          onPointerDown={() => undefined}
        >
          <span className="yuri-mobile-entity-title min-w-0 flex-1 truncate text-left font-medium text-muted-foreground">
            {session.title}
          </span>
          {session.subtitle ? <span className="text-muted-foreground">{session.subtitle}</span> : null}
          <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div className={cn('yuri-mobile-session-row relative isolate', className)}>
      {/* iOS-style trailing rail: it stays fixed underneath while the complete
          session foreground follows the finger to the left. */}
      <MobileSwipeActionRail swipe={swipe} actions={[
        { label: pinLabel, icon: session.pinned ? 'unpin' : 'pushpin', onClick: () => onPin(session) },
        { label: t('sessions.sidebar.bulkActions.archive'), icon: 'archive', destructive: true, onClick: () => onArchive(session) },
      ]} />

      {/* The entire solid foreground translates as one slab, including time
          and overflow menu, matching the native iOS swipe model. */}
      <div
        className={cn(
          'yuri-mobile-session-row-content relative z-10 flex items-center',
          'text-foreground',
          'ease-out motion-reduce:transition-none',
          dragging ? 'transition-none' : 'transition-[transform,background-color] duration-150',
          session.archived && 'opacity-55',
        )}
        data-dragging={dragging ? 'true' : undefined}
        style={{
          transform: `translate3d(${offset}px, 0, 0)`,
          willChange: offset === 0 ? undefined : 'transform',
        }}
      >
        {hasChildren && onToggleChildren ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="min-h-9 min-w-9 shrink-0 rounded-full text-muted-foreground"
            aria-label={expanded
              ? t('sessions.sidebar.session.subsessions.collapse')
              : t('sessions.sidebar.session.subsessions.expand')}
            onClick={handleToggleChildren}
          >
            <Icon
              name="arrow-down-s"
              className={cn(
                'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
                expanded ? 'rotate-0' : '-rotate-90',
              )}
            />
          </Button>
        ) : null}

        <button
          type="button"
          data-mobile-press-feedback="soft"
          className="yuri-mobile-session-row-main flex min-w-0 flex-1 items-center text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
          style={{
            paddingLeft: 16 + Math.min(depth, 4) * 12,
            touchAction: 'pan-y',
          }}
          onClick={handleSelect}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={handlePointerCancel}
          onContextMenu={handleContextMenu}
        >
          <span
            className="yuri-mobile-session-status shrink-0"
            data-session-status={resolvedIndicator}
            aria-hidden={indicatorLabel ? undefined : true}
            aria-label={indicatorLabel}
            title={indicatorLabel}
          >
            {resolvedIndicator === 'running' ? (
              <SessionBusyIndicator className="motion-reduce:[&_svg]:animate-none" />
            ) : resolvedIndicator === 'question' ? (
              <Icon name="question" className="size-3.5 text-[var(--status-warning)]" />
            ) : resolvedIndicator === 'permission' ? (
              <Icon name="shield" className="size-3.5 text-destructive" />
            ) : (
              <span
                className={cn(
                  'yuri-mobile-session-dot rounded-full',
                  resolvedIndicator === 'completed-unread'
                    ? 'bg-[var(--status-info)]'
                    : 'bg-muted-foreground/35',
                )}
              />
            )}
          </span>

          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn('yuri-mobile-session-title truncate', session.unread ? 'font-semibold' : 'font-medium')}>
                {highlightQuery ? renderHighlightedText(session.title, highlightQuery) : session.title}
              </span>
              {session.changes ? (
                <span className="yuri-mobile-session-changes shrink-0 tabular-nums text-muted-foreground">
                  {session.changes}
                </span>
              ) : null}
              {session.archived ? <Icon name="archive" className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
            </span>
            {session.subtitle ? (
              <span className="yuri-mobile-session-subtitle truncate text-muted-foreground">
                {highlightQuery ? renderHighlightedText(session.subtitle, highlightQuery) : session.subtitle}
              </span>
            ) : null}
          </span>

          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            {session.activityLabel ? (
              <span className="yuri-mobile-session-time tabular-nums">{session.activityLabel}</span>
            ) : null}
          </span>
        </button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="mr-1 min-h-9 min-w-9 shrink-0 rounded-full text-muted-foreground"
          aria-label={t('sessions.sidebar.session.menu.label')}
          data-session-drag-ignore
          onClick={handleOpenActions}
        >
          <Icon name="more-2" className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export const MobileSessionRow = React.memo(MobileSessionRowImpl);
