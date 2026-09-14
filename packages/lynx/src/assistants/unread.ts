import type { LynxAssistantReadPosition, LynxAssistantSnapshot } from './types';

/** Cap mark-all fanout batch size. */
export const LYNX_ASSISTANT_MARK_ALL_BATCH_SIZE = 4;

export type LynxAssistantUnreadBadgeModel = {
  visible: boolean;
  display: string;
  count: number;
};

/**
 * Cap `AssistantUnreadBadge`: hide when count is not > 0; cap display at 99+.
 * Failure must not be passed in as 0 — callers pass only authoritative counts.
 */
export const formatLynxAssistantUnreadBadge = (count: number): LynxAssistantUnreadBadgeModel => {
  if (!(count > 0)) {
    return { visible: false, display: '', count };
  }
  return {
    visible: true,
    display: count > 99 ? '99+' : String(count),
    count,
  };
};

/** Cap `selectAssistantUnreadTotal` — disabled catalog is 0, not unknown. */
export const selectLynxAssistantUnreadTotal = (snapshot: LynxAssistantSnapshot): number => (
  snapshot.enabled
    ? snapshot.assistants.reduce((total, assistant) => total + assistant.unreadCount, 0)
    : 0
);

/** Cap mark-all targets: unreadCount > 0 and a real readTip (never invent). */
export const lynxAssistantsEligibleForMarkAll = (
  snapshot: LynxAssistantSnapshot,
): Array<{ id: string; position: LynxAssistantReadPosition }> => (
  snapshot.assistants
    .filter((assistant) => assistant.unreadCount > 0 && assistant.readTip)
    .map((assistant) => ({
      id: assistant.id,
      position: { ...assistant.readTip! },
    }))
);

/**
 * Portable Lynx read-marker input. Cap uses IntersectionObserver + bottom-of-scroll
 * + focus/visibility. Without a host geometry binder, Lynx marks only when the
 * user is viewing that assistant conversation and the snapshot already has a
 * readTip — never invent a position.
 */
export const resolveLynxAssistantOpenReadPosition = (input: {
  viewing: boolean;
  readTip: LynxAssistantReadPosition | null | undefined;
}): LynxAssistantReadPosition | null => {
  if (!input.viewing || !input.readTip) return null;
  return input.readTip;
};
