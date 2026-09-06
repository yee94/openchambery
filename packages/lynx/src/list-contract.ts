/**
 * Chat list engine contract for this track.
 *
 * Lynx must implement 1.19 LegendList semantics (`TimelineList.tsx`):
 * - one list owns history + live tail
 * - initialScrollAtEnd / maintainScrollAtEnd / maintainVisibleContentPosition
 * - rows are never recycled
 * - mobile load-older is a button
 *
 * Forbidden: 1.18 TanStack Virtual split (`StaticHistoryList` +
 * `StreamingTailContent`). This scaffold does not ship a transcript list.
 */
export const LYNX_CHAT_LIST_ENGINE = 'legendlist-1.19' as const;

export const LYNX_FORBIDDEN_CHAT_LIST_ENGINE = 'tanstack-virtual-1.18' as const;
