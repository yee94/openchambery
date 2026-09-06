/**
 * Cap useHeaderSwipeToSessions pure helpers for Expo Chat body.
 * RTL (~35% viewport) opens sessions sheet; LTR maps to secondary back.
 */

export type HeaderSwipeInput = {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  viewportWidth: number;
  disabled: boolean;
  startedOnExcludedTarget: boolean;
};

export type HeaderSwipeResult = {
  open: boolean;
  back: boolean;
};

const MAX_OFF_AXIS_RATIO = 0.85;
const INTENT_DISTANCE = 8;
const OPEN_DISTANCE_RATIO = 0.35;

const leftward = (startX: number, endX: number) => Math.max(0, startX - endX);
const rightward = (startX: number, endX: number) => Math.max(0, endX - startX);
const openDistance = (viewportWidth: number) => viewportWidth * OPEN_DISTANCE_RATIO;
const onAxis = (dx: number, dy: number) => {
  const absDx = Math.abs(dx);
  if (absDx < INTENT_DISTANCE) return true;
  return Math.abs(dy) <= absDx * MAX_OFF_AXIS_RATIO;
};

export const evaluateHeaderSwipe = (input: HeaderSwipeInput): HeaderSwipeResult => {
  if (input.disabled) return { open: false, back: false };
  if (input.startedOnExcludedTarget) return { open: false, back: false };
  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  const open = leftward(input.startX, input.endX) >= openDistance(input.viewportWidth) && onAxis(dx, dy);
  const back = rightward(input.startX, input.endX) >= openDistance(input.viewportWidth) && onAxis(dx, dy);
  return { open, back };
};
