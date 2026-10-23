import React from 'react';
import { createPortal } from 'react-dom';
import { useEvent } from '@reactuses/core';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from "@/components/icon/Icon";
import { canReorderVisibleSessions } from './sessionSortableOrder';
import { SessionRowDragContext } from './sessionDragState';
import { triggerMobileHaptic } from '@/hooks/streamingHaptics';

const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });
const sessionDragModifiers = [restrictToVerticalAxis];

export const DraggableSessionRow: React.FC<{
  sessionId: string;
  sessionDirectory: string | null;
  sessionTitle: string;
  children: React.ReactNode;
}> = ({ sessionId, sessionDirectory, sessionTitle, children }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `session-drag:${sessionId}`,
    data: { type: 'session', sessionId, sessionDirectory, sessionTitle },
  });

  const handleMouseDown = useEvent((event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input, textarea, button[aria-label], [data-session-drag-ignore]')) return;
    event.stopPropagation();
    listeners?.onMouseDown?.(event);
  });
  const handleTouchStart = useEvent((event: React.TouchEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input, textarea, button[aria-label], [data-session-drag-ignore]')) return;
    event.stopPropagation();
    listeners?.onTouchStart?.(event);
  });

  return (
    <div
      ref={setNodeRef}
      data-session-sortable-row
      {...attributes}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? 'opacity-30' : undefined}
    >
      <SessionRowDragContext.Provider value={isDragging}>{children}</SessionRowDragContext.Provider>
    </div>
  );
};

export const DroppableFolderWrapper: React.FC<{
  folderId: string;
  children: (
    droppableRef: (node: HTMLElement | null) => void,
    isOver: boolean,
  ) => React.ReactNode;
}> = ({ folderId, children }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: `folder-drop:${folderId}`,
    data: { type: 'folder', folderId },
  });
  return <>{children(setNodeRef, isOver)}</>;
};

export const SessionFolderDndScope: React.FC<{
  scopeKey: string | null;
  onSessionDroppedOnFolder: (sessionId: string, folderId: string) => void;
  sessionIds: string[];
  folderIdBySessionId: ReadonlyMap<string, string | null>;
  onSessionsReordered: (activeSessionId: string, overSessionId: string) => void;
  children: React.ReactNode;
}> = ({ scopeKey, onSessionDroppedOnFolder, sessionIds, folderIdBySessionId, onSessionsReordered, children }) => {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 6 } }),
  );
  const [activeDragId, setActiveDragId] = React.useState<string | null>(null);
  const [activeDragTitle, setActiveDragTitle] = React.useState<string>('Session');
  const [activeDragWidth, setActiveDragWidth] = React.useState<number | null>(null);
  const [activeDragHeight, setActiveDragHeight] = React.useState<number | null>(null);

  if (!scopeKey) {
    return <>{children}</>;
  }

  const handleDragEnd = (event: DragEndEvent) => {
    triggerMobileHaptic('light', { bypassCadence: true });
    setActiveDragId(null);
    setActiveDragWidth(null);
    setActiveDragHeight(null);
    const { active, over } = event;
    if (!over) return;
    const activeData = active.data.current as { type?: string; sessionId?: string } | undefined;
    const overData = over.data.current as { type?: string; folderId?: string } | undefined;
    if (activeData?.type === 'session' && activeData.sessionId && overData?.type === 'folder' && overData.folderId) {
      onSessionDroppedOnFolder(activeData.sessionId, overData.folderId);
      return;
    }
    if (activeData?.type === 'session' && activeData.sessionId && overData?.type === 'session' && typeof over.id === 'string') {
      const overSessionId = over.id.replace(/^session-drag:/, '');
      if (canReorderVisibleSessions(activeData.sessionId, overSessionId, folderIdBySessionId)) {
        onSessionsReordered(activeData.sessionId, overSessionId);
      }
    }
  };

  return (
    <DndContext
      sensors={sensors}
      modifiers={sessionDragModifiers}
      collisionDetection={closestCenter}
      onDragStart={(event) => {
        const data = event.active.data.current as { type?: string; sessionId?: string; sessionTitle?: string } | undefined;
        if (data?.type === 'session' && data.sessionId) {
          triggerMobileHaptic('medium', { bypassCadence: true });
          setActiveDragId(data.sessionId);
          setActiveDragTitle(data.sessionTitle ?? 'Session');
          const width = event.active.rect.current.initial?.width;
          const height = event.active.rect.current.initial?.height;
          setActiveDragWidth(typeof width === 'number' ? width : null);
          setActiveDragHeight(typeof height === 'number' ? height : null);
        }
      }}
      onDragCancel={() => {
        triggerMobileHaptic('light', { bypassCadence: true });
        setActiveDragId(null);
        setActiveDragWidth(null);
        setActiveDragHeight(null);
      }}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={sessionIds.map((sessionId) => `session-drag:${sessionId}`)} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
      {typeof document !== 'undefined' ? createPortal(<DragOverlay>
        {activeDragId ? (
          <div
            style={{
              width: activeDragWidth ? `${activeDragWidth}px` : 'auto',
              height: activeDragHeight ? `${activeDragHeight}px` : 'auto',
            }}
            className="flex items-center rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2.5 py-1 shadow-none pointer-events-none"
          >
            <Icon name="chat-thread" className="h-4 w-4 text-muted-foreground mr-2 flex-shrink-0" />
            <div className="min-w-0 flex-1 truncate typography-ui-label font-normal text-foreground">
              {activeDragTitle}
            </div>
          </div>
        ) : null}
      </DragOverlay>, document.body) : null}
    </DndContext>
  );
};
