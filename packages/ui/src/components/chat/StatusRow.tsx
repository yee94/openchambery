import React from "react";
import { useSessionUIStore } from '@/sync/session-ui-store';
import { cn } from "@/lib/utils";
import { useDirectorySync } from "@/sync/sync-context";
import type { Todo } from "@opencode-ai/sdk/v2/client";
import { TodoItemRow } from "./TodoItemRow";

// Compat aliases for old TodoItem shape
type TodoItem = Todo & { id?: string };
import { useUIStore } from "@/stores/useUIStore";
import { useTodosPersistStore } from "@/stores/useTodosPersistStore";
import { WorkingPlaceholder } from "./message/parts/WorkingPlaceholder";
import { isVSCodeRuntime } from "@/lib/desktop";
import { Icon } from "@/components/icon/Icon";
import { useI18n } from "@/lib/i18n";
import { useSessionSurface } from "./SessionSurfaceContext";
import {
  statusBarPopoverClassName,
  statusBarPopoverHeaderClassName,
  statusBarPopoverHeaderMetaClassName,
  statusBarPopoverHeaderTitleClassName,
  statusBarPopoverListClassName,
  statusBarPopoverStyle,
  statusBarTriggerClassName,
  statusBarTriggerIconClassName,
  statusBarTriggerLabelClassName,
  statusBarTriggerMetaClassName,
} from "./statusBarPopover";

const STATUS_ROW_CONTAINER_STYLE = { containerType: "inline-size" as const, containerName: "status-row" };

const EMPTY_TODOS: TodoItem[] = [];

interface StatusRowProps {
  // Working state
  isWorking?: boolean;
  statusText?: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  wasAborted?: boolean;
  abortActive?: boolean;
  retryInfo?: { attempt?: number; next?: number } | null;
  // Abort status display
  showAbortStatus?: boolean;
  /** First Esc armed: show "press Esc again to abort" until window expires. */
  showAbortPrompt?: boolean;
  showAssistantStatus?: boolean;
  showTodos?: boolean;
  agentName?: string;
  leftAccessory?: React.ReactNode;
}

export const StatusRow: React.FC<StatusRowProps> = ({
  isWorking = false,
  statusText = null,
  isGenericStatus,
  isWaitingForPermission,
  wasAborted,
  abortActive,
  retryInfo,
  showAbortStatus,
  showAbortPrompt = false,
  showAssistantStatus = true,
  showTodos = true,
  agentName,
  leftAccessory,
}) => {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const sessionSurface = useSessionSurface();
  const primarySessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionId = sessionSurface.sessionId ?? primarySessionId;
  const liveTodos = useDirectorySync(
    React.useCallback(
      (state) => {
        if (!showTodos || !currentSessionId) return EMPTY_TODOS;
        return state.todo[currentSessionId] ?? EMPTY_TODOS;
      },
      [currentSessionId, showTodos],
    ),
    sessionSurface.directory ?? undefined,
  );
  const persistedSessionTodos = useTodosPersistStore(
    React.useCallback(
      (state) => (showTodos && currentSessionId ? state.sessions[currentSessionId]?.todos : undefined),
      [currentSessionId, showTodos],
    ),
  );
  const todos: TodoItem[] = React.useMemo(() => {
    if (!currentSessionId) return EMPTY_TODOS;
    if (liveTodos.length > 0) return liveTodos;
    return persistedSessionTodos ?? EMPTY_TODOS;
  }, [liveTodos, persistedSessionTodos, currentSessionId]);
  const isMobile = useUIStore((state) => state.isMobile);
  const isCompact = isMobile || isVSCodeRuntime();

  // Filter out cancelled todos for display and keep original order.
  // This prevents items from jumping around when status changes.
  const visibleTodos = React.useMemo(() => {
    return todos.filter((todo) => todo.status !== "cancelled");
  }, [todos]);

  // Find the current active todo (first in_progress, or first pending)
  const activeTodo = React.useMemo(() => {
    return (
      visibleTodos.find((t) => t.status === "in_progress") ||
      visibleTodos.find((t) => t.status === "pending") ||
      null
    );
  }, [visibleTodos]);
  const focusedTodo = React.useMemo(
    () => visibleTodos.find((todo) => todo.status === "in_progress") ?? null,
    [visibleTodos],
  );

  // Calculate progress
  const progress = React.useMemo(() => {
    const total = todos.filter((t) => t.status !== "cancelled").length;
    const completed = todos.filter((t) => t.status === "completed").length;
    return { completed, total };
  }, [todos]);

  const statusSummary = React.useMemo(() => {
    const active = visibleTodos.filter((t) => t.status === "in_progress").length;
    const left = visibleTodos.filter((t) => t.status === "in_progress" || t.status === "pending").length;
    return { active, left };
  }, [visibleTodos]);

  const hasTodoContent = showTodos && statusSummary.left > 0;
  const hasAbortPrompt = Boolean(showAbortPrompt);
  const hasAssistantContent = showAssistantStatus && (
    isWorking ||
    Boolean(wasAborted) ||
    Boolean(showAbortStatus)
  );
  const hasLeftAccessory = Boolean(leftAccessory);
  // Original logic from ChatInput
  const shouldRenderPlaceholder = !showAbortStatus && !hasAbortPrompt && (wasAborted || !abortActive);

  const hasContent = hasAbortPrompt || hasAssistantContent || hasTodoContent || hasLeftAccessory;

  // Close popover when clicking outside
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const todoListRef = React.useRef<HTMLUListElement>(null);
  const activeTodoRef = React.useRef<HTMLLIElement>(null);
  React.useLayoutEffect(() => {
    const list = todoListRef.current;
    const activeItem = activeTodoRef.current;
    if (!isExpanded || !list || !activeItem) return;

    const centeredScrollTop = activeItem.offsetTop - list.offsetTop - (list.clientHeight - activeItem.offsetHeight) / 2;
    const maxScrollTop = list.scrollHeight - list.clientHeight;
    list.scrollTop = Math.min(maxScrollTop, Math.max(0, centeredScrollTop));
  }, [isExpanded]);

  React.useEffect(() => {
    if (!isExpanded) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsExpanded(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded]);

  const toggleExpanded = () => setIsExpanded((prev) => !prev);
  const todoSummaryLabel = t('chat.statusRow.summary.activeLeft', {
    active: statusSummary.active,
    left: statusSummary.left,
  });

  // Todo trigger button
  const todoTrigger = hasTodoContent ? (
    <button
      type="button"
      onClick={toggleExpanded}
      className={cn(statusBarTriggerClassName, "shrink-0")}
      aria-label={todoSummaryLabel}
      title={todoSummaryLabel}
    >
      <Icon name="list-check-3" className={statusBarTriggerIconClassName} />
      {/* Desktop: show task text; Mobile/VSCode: just "Tasks" */}
      {!isCompact && activeTodo ? (
        <span className={cn("status-row__active-todo max-w-[200px]", statusBarTriggerLabelClassName)}>
          {activeTodo.content}
        </span>
      ) : (
        <span className="text-xs leading-4 md:text-[0.8125rem] md:leading-5">{t('chat.statusRow.tasksTitle')}</span>
      )}
      <span className={statusBarTriggerMetaClassName} aria-hidden="true">
        {progress.completed}/{progress.total}
      </span>
      {isExpanded ? (
        <Icon name="arrow-up-s" className={statusBarTriggerIconClassName} />
      ) : (
        <Icon name="arrow-down-s" className={statusBarTriggerIconClassName} />
      )}
    </button>
  ) : null;

  // Don't render if nothing to show
  if (!hasContent) {
    return null;
  }

  return (
    <div className={cn("mb-1", !hasLeftAccessory && "chat-column")} style={STATUS_ROW_CONTAINER_STYLE}>
      <div className={cn("flex items-center justify-between py-0.5 gap-2 h-[1.2rem]", hasLeftAccessory && "px-0.5")}>
        {/* Left: Abort prompt | Abort status | Working placeholder | leftAccessory */}
        <div className={cn("flex-1 flex items-center min-w-0 gap-2", hasLeftAccessory ? "pl-1.5" : "overflow-x-hidden")}>
          {hasAbortPrompt ? (
            <div
              className="flex min-w-0 items-center text-muted-foreground pl-0.5"
              role="status"
              aria-live="polite"
              aria-label={t('chat.statusRow.abortPrompt')}
            >
              <span className="flex min-w-0 items-center gap-1.5 typography-ui-label">
                <Icon name="error-warning" className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="animate-text-shimmer truncate whitespace-nowrap">
                  {t('chat.statusRow.abortPrompt')}
                </span>
              </span>
            </div>
          ) : showAssistantStatus && showAbortStatus ? (
            <div className="flex h-full items-center text-[var(--status-error)] pl-0.5">
              <span className="flex items-center gap-1.5 typography-ui-label">
                <Icon name="close-circle" aria-hidden="true"/>
                {t('chat.statusRow.aborted')}
              </span>
            </div>
          ) : showAssistantStatus && shouldRenderPlaceholder ? (
            <WorkingPlaceholder
              key={currentSessionId ?? "no-session"}
              isWorking={isWorking}
              statusText={statusText}
              isGenericStatus={isGenericStatus}
              isWaitingForPermission={isWaitingForPermission}
              retryInfo={retryInfo}
              agentName={agentName}
            />
          ) : leftAccessory ? (
            leftAccessory
          ) : null}
        </div>

        {/* Right: Todo */}
        <div className={cn("relative flex items-center gap-2 flex-shrink-0", hasLeftAccessory ? "pr-1.5" : "-mr-3")} ref={popoverRef}>
          {todoTrigger}

          {/* Popover dropdown */}
          {isExpanded && hasTodoContent && (
            <div
              style={statusBarPopoverStyle}
              className={cn(
                statusBarPopoverClassName,
                "absolute right-0 bottom-full mb-1 z-50",
                "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
                "duration-150"
              )}
            >
              {/* Header */}
              <div className={statusBarPopoverHeaderClassName}>
                <span className={statusBarPopoverHeaderTitleClassName}>{t('chat.statusRow.tasksTitle')}</span>
                <span className={statusBarPopoverHeaderMetaClassName}>
                  {progress.completed}/{progress.total}
                </span>
              </div>

              {/* Todo list */}
              <ul
                ref={todoListRef}
                className={statusBarPopoverListClassName}
              >
                {visibleTodos.map((todo, index) => (
                  <TodoItemRow
                    key={todo.id ?? `todo-${index}`}
                    todo={todo}
                    isActive={todo === focusedTodo}
                    activeRef={todo === focusedTodo ? activeTodoRef : undefined}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
