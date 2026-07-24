import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { SessionBusyIndicator } from '@/components/session/SessionBusyIndicator';
import { Button } from '@/components/ui/button';
import {
  createMobileLongPressController,
  type MobileLongPressController,
} from '@/components/ui/mobileLongPress';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import {
  resolveMobileSessionIndicator,
  type MobileSessionIndicator,
} from './mobileSessionIndicator';

const INTENT_LOCK_PX = 10;

/**
 * Cross-row coordination: only one session row stays swipe-revealed at a time.
 * When a row locks into a horizontal swipe, it broadcasts its id so every
 * other revealed row closes.
 */
const REVEALED_ROW_EVENT = 'oc:mobile-session-row-revealed';

const broadcastRowRevealed = (id: string): void => {
  window.dispatchEvent(new CustomEvent(REVEALED_ROW_EVENT, { detail: id }));
};

type GestureIntent = 'pending' | 'horizontal' | 'vertical';

type ActiveGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: number;
  actionWidth: number;
  intent: GestureIntent;
};

export type MobileSessionRowModel = {
  id: string;
  kind?: 'session' | 'pagination';
  title: string;
  subtitle?: string;
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
  /** Opens the complete action sheet. This is also used by long press and the visible actions button. */
  onOpenActions: (session: MobileSessionRowModel) => void;
  indicator?: MobileSessionIndicator;
  className?: string;
};

export function MobileSessionRow({
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
}: MobileSessionRowProps) {
  const { t } = useI18n();
  const [offset, setOffset] = React.useState(0);
  const [pressed, setPressed] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const gestureRef = React.useRef<ActiveGesture | null>(null);
  const suppressClickRef = React.useRef(false);
  const actionRailRef = React.useRef<HTMLDivElement | null>(null);
  const longPressRef = React.useRef<MobileLongPressController | null>(null);

  if (!longPressRef.current) {
    longPressRef.current = createMobileLongPressController({
      onPressedKeyChange: (key) => setPressed(key === session.id),
    });
  }

  React.useEffect(() => () => longPressRef.current?.reset(), []);

  React.useEffect(() => {
    const handleRevealed = (event: Event) => {
      const revealedId = (event as CustomEvent<string>).detail;
      if (revealedId !== session.id) setOffset(0);
    };
    window.addEventListener(REVEALED_ROW_EVENT, handleRevealed);
    return () => window.removeEventListener(REVEALED_ROW_EVENT, handleRevealed);
  }, [session.id]);

  React.useEffect(() => {
    setOffset(0);
  }, [session.id]);

  const closeActions = useEvent(() => setOffset(0));
  const revealed = offset !== 0;

  const handlePointerDown = useEvent((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // Swipe reveal is touch/pen only — mouse drag on desktop left residual
    // offsets that painted Pin/Archive over the title.
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;

    const actionWidth = actionRailRef.current?.offsetWidth ?? 0;
    if (actionWidth <= 0) return;

    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: offset,
      actionWidth,
      intent: 'pending',
    };
    suppressClickRef.current = false;

    longPressRef.current?.start({
      pointerId: event.pointerId,
      key: session.id,
      clientX: event.clientX,
      clientY: event.clientY,
      onTrigger: () => {
        setPressed(false);
        onOpenActions(session);
      },
    });
  });

  const handlePointerMove = useEvent((event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    longPressRef.current?.move(event.pointerId, event.clientX, event.clientY);

    if (gesture.intent === 'pending') {
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (absY > INTENT_LOCK_PX && absY > absX) {
        gesture.intent = 'vertical';
        gestureRef.current = null;
        longPressRef.current?.cancel(event.pointerId);
        return;
      }
      if (absX > INTENT_LOCK_PX && absX > absY) {
        gesture.intent = 'horizontal';
        setDragging(true);
        suppressClickRef.current = true;
        longPressRef.current?.cancel(event.pointerId);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Some embedded webviews can report a pointer after capture was
          // already released. The row can still finish from the same target.
        }
        broadcastRowRevealed(session.id);
      }
    }

    if (gesture.intent !== 'horizontal') return;
    event.preventDefault();
    // Only swipe left to reveal trailing pin + archive actions.
    const nextOffset = Math.max(-gesture.actionWidth, Math.min(0, gesture.startOffset + deltaX));
    setOffset(nextOffset);
  });

  const finishGesture = useEvent((event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    longPressRef.current?.end(event.pointerId);
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (gesture.intent !== 'horizontal') return;
    setDragging(false);
    setOffset((current) => (current < -(gesture.actionWidth * 0.35) ? -gesture.actionWidth : 0));
  });

  const handlePointerCancel = useEvent((event: React.PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    longPressRef.current?.cancel(event.pointerId);
    setDragging(false);
    setOffset(gesture?.startOffset ?? 0);
  });

  const handleSelect = useEvent(() => {
    if (longPressRef.current?.consumeClick(session.id)) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (offset !== 0) {
      closeActions();
      return;
    }
    broadcastRowRevealed(session.id);
    onSelect(session);
  });

  const handleContextMenu = useEvent((event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    longPressRef.current?.openFromContextMenu(session.id, () => {
      setPressed(false);
      onOpenActions(session);
    });
  });

  const handlePin = useEvent(() => {
    closeActions();
    onPin(session);
  });

  const handleArchive = useEvent(() => {
    closeActions();
    onArchive(session);
  });

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
        'oc-mobile-session-row',
        paginationContinues && 'oc-mobile-session-pagination-continues',
        className,
      )}>
        <button
          type="button"
          data-mobile-press-feedback="soft"
          className="oc-mobile-session-pagination-row"
          onClick={handleSelect}
        >
          <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">
            {session.title}
          </span>
          {session.subtitle ? <span className="text-muted-foreground">{session.subtitle}</span> : null}
          <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div className={cn('oc-mobile-session-row relative isolate overflow-hidden', className)}>
      {/* iOS-style trailing rail: it stays fixed underneath while the complete
          session foreground follows the finger to the left. */}
      <div
        ref={actionRailRef}
        className={cn(
          'oc-mobile-session-actions absolute inset-y-0 right-0 z-0 flex items-stretch',
          dragging ? 'transition-none' : 'transition-transform duration-150 ease-out',
          !revealed && 'invisible pointer-events-none',
        )}
        style={{
          transform: `translate3d(calc(var(--oc-mobile-session-actions-width) + ${offset}px), 0, 0)`,
          willChange: offset === 0 ? undefined : 'transform',
        }}
        aria-hidden={!revealed}
      >
        <Button
          type="button"
          variant="secondary"
          className="oc-mobile-session-action h-full flex-col rounded-none border-0 bg-interactive-selection px-1 text-interactive-selection-foreground hover:bg-interactive-active"
          aria-label={pinLabel}
          tabIndex={revealed ? 0 : -1}
          onClick={handlePin}
        >
          <Icon name={session.pinned ? 'unpin' : 'pushpin'} className="size-[18px]" />
          <span className="oc-mobile-session-action-label font-medium">{pinLabel}</span>
        </Button>
        <Button
          type="button"
          variant="destructive"
          className="oc-mobile-session-action h-full flex-col rounded-none border-0 px-1"
          aria-label={t('sessions.sidebar.bulkActions.archive')}
          tabIndex={revealed ? 0 : -1}
          onClick={handleArchive}
        >
          <Icon name="archive" className="size-[18px]" />
          <span className="oc-mobile-session-action-label font-medium">{t('sessions.sidebar.bulkActions.archive')}</span>
        </Button>
      </div>

      {/* The entire solid foreground translates as one slab, including time
          and overflow menu, matching the native iOS swipe model. */}
      <div
        className={cn(
          'oc-mobile-session-row-content relative z-10 flex items-center',
          'text-foreground',
          'ease-out motion-reduce:transition-none',
          dragging ? 'transition-none' : 'transition-[transform,background-color] duration-150',
          session.active && 'bg-interactive-selection/50',
          session.archived && 'opacity-55',
          pressed && !session.active && 'bg-interactive-hover',
        )}
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
          className="oc-mobile-session-row-main flex min-w-0 flex-1 items-center text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
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
            className="oc-mobile-session-status shrink-0"
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
                  'oc-mobile-session-dot rounded-full',
                  resolvedIndicator === 'completed-unread'
                    ? 'bg-[var(--status-info)]'
                    : 'bg-muted-foreground/35',
                )}
              />
            )}
          </span>

          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn('oc-mobile-session-title truncate', session.unread ? 'font-semibold' : 'font-medium')}>
                {session.title}
              </span>
              {session.pinned ? <Icon name="pushpin" className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
              {session.archived ? <Icon name="archive" className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
            </span>
            {session.subtitle ? (
              <span className="oc-mobile-session-subtitle truncate text-muted-foreground">{session.subtitle}</span>
            ) : null}
          </span>

          <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            {session.activityLabel ? (
              <span className="oc-mobile-session-time tabular-nums">{session.activityLabel}</span>
            ) : null}
          </span>
        </button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="mr-1 min-h-9 min-w-9 shrink-0 rounded-full text-muted-foreground"
          aria-label={t('sessions.sidebar.session.menu.label')}
          onClick={handleOpenActions}
        >
          <Icon name="more-2" className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
