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

const ACTION_WIDTH_PX = 88;
const INTENT_LOCK_PX = 10;
const REVEAL_THRESHOLD_PX = 42;

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
  intent: GestureIntent;
};

export type MobileSessionRowModel = {
  id: string;
  title: string;
  subtitle?: string;
  activityLabel?: string;
  unread?: boolean;
  busy?: boolean;
  pinned?: boolean;
  archived?: boolean;
  active?: boolean;
};

export type MobileSessionRowProps = {
  session: MobileSessionRowModel;
  depth?: number;
  hasChildren?: boolean;
  expanded?: boolean;
  onToggleChildren?: () => void;
  onSelect: (session: MobileSessionRowModel) => void;
  onPin: (session: MobileSessionRowModel) => void;
  onArchive: (session: MobileSessionRowModel) => void;
  /** Opens the complete action sheet. This is also used by long press and the visible actions button. */
  onOpenActions: (session: MobileSessionRowModel) => void;
  className?: string;
};

export function MobileSessionRow({
  session,
  depth = 0,
  hasChildren = false,
  expanded = false,
  onToggleChildren,
  onSelect,
  onPin,
  onArchive,
  onOpenActions,
  className,
}: MobileSessionRowProps) {
  const { t } = useI18n();
  const [offset, setOffset] = React.useState(0);
  const [pressed, setPressed] = React.useState(false);
  const gestureRef = React.useRef<ActiveGesture | null>(null);
  const suppressClickRef = React.useRef(false);
  const longPressRef = React.useRef<MobileLongPressController | null>(null);

  if (!longPressRef.current) {
    longPressRef.current = createMobileLongPressController({
      onPressedKeyChange: (key) => setPressed(key === session.id),
    });
  }

  React.useEffect(() => () => longPressRef.current?.reset(), []);

  // Close this row's reveal when another row takes over the swipe.
  React.useEffect(() => {
    const handleRevealed = (event: Event) => {
      const revealedId = (event as CustomEvent<string>).detail;
      if (revealedId !== session.id) setOffset(0);
    };
    window.addEventListener(REVEALED_ROW_EVENT, handleRevealed);
    return () => window.removeEventListener(REVEALED_ROW_EVENT, handleRevealed);
  }, [session.id]);

  const closeActions = useEvent(() => setOffset(0));

  const handlePointerDown = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: offset,
      intent: 'pending',
    };
    suppressClickRef.current = false;

    if (event.pointerType === 'touch' || event.pointerType === 'pen') {
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
    }
  });

  const handlePointerMove = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
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
        suppressClickRef.current = true;
        longPressRef.current?.cancel(event.pointerId);
        event.currentTarget.setPointerCapture(event.pointerId);
        broadcastRowRevealed(session.id);
      }
    }

    if (gesture.intent !== 'horizontal') return;
    event.preventDefault();
    const nextOffset = Math.max(-ACTION_WIDTH_PX, Math.min(ACTION_WIDTH_PX, gesture.startOffset + deltaX));
    setOffset(nextOffset);
  });

  const finishGesture = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    longPressRef.current?.end(event.pointerId);
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (gesture.intent !== 'horizontal') return;
    setOffset((current) => current > REVEAL_THRESHOLD_PX
      ? ACTION_WIDTH_PX
      : current < -REVEAL_THRESHOLD_PX
        ? -ACTION_WIDTH_PX
        : 0);
  });

  const handlePointerCancel = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    gestureRef.current = null;
    longPressRef.current?.cancel(event.pointerId);
    setOffset(0);
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
    onSelect(session);
  });

  const handleContextMenu = useEvent((event: React.MouseEvent<HTMLButtonElement>) => {
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

  return (
    <div className={cn('relative overflow-hidden', className)}>
      <div className="absolute inset-0 flex items-stretch justify-between" aria-hidden={offset === 0}>
        <Button
          type="button"
          variant="secondary"
          className="h-full w-[88px] flex-col gap-1 rounded-none bg-[var(--interactive-selection)] px-2 text-[var(--interactive-selectionForeground)] hover:bg-[var(--interactive-active)]"
          aria-label={pinLabel}
          tabIndex={offset > 0 ? 0 : -1}
          onClick={handlePin}
        >
          <Icon name={session.pinned ? 'unpin' : 'pushpin'} className="size-5" />
          <span className="typography-micro">{pinLabel}</span>
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="h-full w-[88px] flex-col gap-1 rounded-none bg-[var(--surface-muted)] px-2 hover:bg-[var(--interactive-active)]"
          aria-label={t('sessions.sidebar.bulkActions.archive')}
          tabIndex={offset < 0 ? 0 : -1}
          onClick={handleArchive}
        >
          <Icon name="archive" className="size-5" />
          <span className="typography-micro">{t('sessions.sidebar.bulkActions.archive')}</span>
        </Button>
      </div>

      <div
        className={cn(
          'relative flex min-h-16 items-stretch border-b border-[var(--surface-subtle)] bg-[var(--surface-elevated)] transition-[transform,background-color,opacity] duration-200 ease-out will-change-transform motion-reduce:transition-none',
          session.active && 'bg-[var(--interactive-selection)] text-[var(--interactive-selectionForeground)]',
          session.archived && 'opacity-55',
          pressed && 'bg-[var(--interactive-active)]',
        )}
        style={{ transform: `translate3d(${offset}px, 0, 0)` }}
      >
        {hasChildren && onToggleChildren ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 self-center rounded-full text-muted-foreground"
            aria-label={expanded
              ? t('sessions.sidebar.session.subsessions.collapse')
              : t('sessions.sidebar.session.subsessions.expand')}
            onClick={handleToggleChildren}
          >
            <Icon
              name="arrow-down-s"
              className={cn('size-4 transition-transform duration-200 motion-reduce:transition-none', expanded ? 'rotate-0' : '-rotate-90')}
            />
          </Button>
        ) : (
          <span className="w-3 shrink-0" aria-hidden />
        )}

        <button
          type="button"
          className={cn(
            'flex min-h-16 min-w-0 flex-1 items-center gap-3 py-2.5 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]',
          )}
          style={{ paddingLeft: Math.min(depth, 5) * 16, touchAction: 'pan-y' }}
          onClick={handleSelect}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={handlePointerCancel}
          onContextMenu={handleContextMenu}
        >
          <span className="relative flex size-8 shrink-0 items-center justify-center" aria-hidden>
            <span className={cn('size-2 rounded-full bg-[var(--surface-mutedForeground)]', session.unread && 'bg-[var(--status-info)]')} />
            {session.unread ? <span className="absolute size-4 animate-ping rounded-full bg-[var(--status-info-background)] motion-reduce:animate-none" /> : null}
          </span>

          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn('truncate typography-ui-label', session.unread && 'font-semibold')}>{session.title}</span>
              {session.pinned ? <Icon name="pushpin" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
              {session.archived ? <Icon name="archive" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
            </span>
            {session.subtitle ? <span className="truncate typography-micro text-muted-foreground">{session.subtitle}</span> : null}
          </span>

          <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
            {session.activityLabel ? <span className="typography-micro tabular-nums">{session.activityLabel}</span> : null}
            {session.busy ? <SessionBusyIndicator className="motion-reduce:[&_svg]:animate-none" /> : null}
          </span>
        </button>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 self-center rounded-full text-muted-foreground"
          aria-label={t('sessions.sidebar.session.menu.label')}
          onClick={handleOpenActions}
        >
          <Icon name="more-2" className="size-5" />
        </Button>
      </div>
    </div>
  );
}
