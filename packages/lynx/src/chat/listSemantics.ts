/**
 * 1.19 LegendList chat-list semantics for Lynx.
 *
 * Source of truth: packages/ui TimelineList.tsx + docs/lynx-pitfalls.md §9.
 * Forbidden: 1.18 TanStack Virtual split (StaticHistoryList + StreamingTailContent).
 */
export const LYNX_CHAT_LIST_ENGINE = 'legendlist-1.19' as const;
export const LYNX_FORBIDDEN_CHAT_LIST_ENGINE = 'tanstack-virtual-1.18' as const;

/** The list *is* the scroll view — no nested scroller around transcript rows. */
export const LYNX_LIST_IS_SCROLLVIEW = true as const;

/** Rows never recycle — tool expand / permission cards keep per-turn state. */
export const LYNX_RECYCLE_ITEMS = false as const;

/** Cold open parks at the live edge. */
export const LYNX_INITIAL_SCROLL_AT_END = true as const;

/**
 * Mobile load-older is a button. Bounce / overscroll must never auto-fetch
 * earlier history (Cap useChatTimelineController mobile path).
 */
export const LYNX_LOAD_OLDER_TRIGGER = 'button' as const;

export type LynxMaintainScrollAtEnd =
  | false
  | {
      animated: boolean;
      on: {
        dataChange: boolean;
        itemLayout: boolean;
        layout: boolean;
        footerLayout: boolean;
      };
    };

export type LynxMaintainVisibleContentPosition = {
  data: boolean;
  size: boolean;
  shouldRestorePosition?: (entry: { key: string }) => boolean;
};

export type LynxTimelineListFlags = {
  engine: typeof LYNX_CHAT_LIST_ENGINE;
  listIsScrollView: typeof LYNX_LIST_IS_SCROLLVIEW;
  recycleItems: typeof LYNX_RECYCLE_ITEMS;
  initialScrollAtEnd: typeof LYNX_INITIAL_SCROLL_AT_END;
  loadOlderTrigger: typeof LYNX_LOAD_OLDER_TRIGGER;
  maintainScrollAtEnd: LynxMaintainScrollAtEnd;
  maintainVisibleContentPosition: LynxMaintainVisibleContentPosition;
};

/**
 * Resolve LegendList follow / prepend flags for a Lynx timeline mount.
 * Matches Cap TimelineList: follow stays off while a history anchor owns scroll.
 */
export function resolveLynxTimelineListFlags(input: {
  followEnabled: boolean;
  historyAnchorActive: boolean;
  sessionIsWorking: boolean;
  endSettledOnce: boolean;
  prependSettling: boolean;
  knownKeys?: ReadonlySet<string>;
}): LynxTimelineListFlags {
  const maintainScrollAtEnd: LynxMaintainScrollAtEnd =
    !input.followEnabled || input.historyAnchorActive
      ? false
      : {
          animated: input.sessionIsWorking && input.endSettledOnce,
          on: {
            dataChange: true,
            itemLayout: true,
            layout: true,
            footerLayout: true,
          },
        };

  const maintainVisibleContentPosition: LynxMaintainVisibleContentPosition =
    input.historyAnchorActive && input.knownKeys
      ? {
          data: true,
          size: true,
          shouldRestorePosition: (entry) => input.knownKeys!.has(entry.key),
        }
      : {
          data: true,
          size: input.prependSettling,
        };

  return {
    engine: LYNX_CHAT_LIST_ENGINE,
    listIsScrollView: LYNX_LIST_IS_SCROLLVIEW,
    recycleItems: LYNX_RECYCLE_ITEMS,
    initialScrollAtEnd: LYNX_INITIAL_SCROLL_AT_END,
    loadOlderTrigger: LYNX_LOAD_OLDER_TRIGGER,
    maintainScrollAtEnd,
    maintainVisibleContentPosition,
  };
}

export function assertLegendListEngine(engine: string): void {
  if (engine === LYNX_FORBIDDEN_CHAT_LIST_ENGINE) {
    throw new Error('TanStack Virtual 1.18 chat list is forbidden on the Lynx track');
  }
  if (engine !== LYNX_CHAT_LIST_ENGINE) {
    throw new Error(`Unsupported Lynx chat list engine: ${engine}`);
  }
}
