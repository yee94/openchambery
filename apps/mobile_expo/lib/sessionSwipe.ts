/**
 * Cap useEdgeSwipeSessionSwitch pure helpers for Expo Chat composer surface.
 * Left swipe → next/older; right swipe → prev/newer. Composer-owned only.
 */

export type SwipeDirection = 'prev' | 'next' | null;

export type SwipeDirectionInput = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

const MIN_DISTANCE = 64;
const MAX_OFF_AXIS_RATIO = 0.6;
export const NATIVE_IOS_BACK_EDGE_WIDTH = 28;

export type SessionSwipeStartInput = {
  onExplicitSurface: boolean;
  onCodeBlock: boolean;
  withinHorizontalScroller: boolean;
  withinNativeBackEdge?: boolean;
  composerActive?: boolean;
};

export const shouldStartSessionSwipe = (input: SessionSwipeStartInput): boolean => {
  if (input.composerActive) return false;
  if (input.onCodeBlock || input.withinHorizontalScroller || input.withinNativeBackEdge) {
    return false;
  }
  return input.onExplicitSurface;
};

export const evaluateSwipeDirection = (input: SwipeDirectionInput): SwipeDirection => {
  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  if (absDx < MIN_DISTANCE) return null;
  if (absDy > absDx * MAX_OFF_AXIS_RATIO) return null;
  return dx < 0 ? 'next' : 'prev';
};

export type RankedSessionId = { id: string; activityMs: number };

/** Top-level sessions newest-first — Cap orderedTopLevelSessions contract. */
export const rankSessionsForSwipe = (
  sessions: Array<{ id: string; parentID?: string | null; activityMs: number }>,
): string[] =>
  sessions
    .filter((session) => !session.parentID)
    .slice()
    .sort((a, b) => b.activityMs - a.activityMs)
    .map((session) => session.id);

export const resolveSessionSwipeNeighbor = (
  orderedIds: string[],
  currentId: string | null,
  direction: Exclude<SwipeDirection, null>,
): string | null => {
  if (!currentId) return null;
  const index = orderedIds.indexOf(currentId);
  if (index < 0) return null;
  if (direction === 'prev') return index > 0 ? orderedIds[index - 1]! : null;
  return index < orderedIds.length - 1 ? orderedIds[index + 1]! : null;
};

export const isNativeIosBackEdgeStart = (clientX: number, platform: string): boolean =>
  platform === 'ios' && clientX <= NATIVE_IOS_BACK_EDGE_WIDTH;
