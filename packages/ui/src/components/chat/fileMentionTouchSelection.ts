export interface MentionTouchSelectionController {
  pointerDown: (x: number, y: number) => void;
  pointerMove: (x: number, y: number) => void;
  pointerCancel: () => void;
  pointerUp: (select: () => void) => boolean;
  click: (select: () => void) => boolean;
}

export const createMentionTouchSelectionController = (): MentionTouchSelectionController => {
  let start: { x: number; y: number } | null = null;
  let moved = false;
  let ignoreClick = false;

  return {
    pointerDown: (x, y) => {
      start = { x, y };
      moved = false;
    },
    pointerMove: (x, y) => {
      if (!start) return;
      if (Math.hypot(x - start.x, y - start.y) > 6) moved = true;
    },
    pointerCancel: () => {
      start = null;
      moved = false;
    },
    pointerUp: (select) => {
      if (!start) return false;
      const shouldSelect = !moved;
      start = null;
      moved = false;
      if (!shouldSelect) {
        ignoreClick = true;
        return false;
      }
      ignoreClick = true;
      select();
      return true;
    },
    click: (select) => {
      if (ignoreClick) {
        ignoreClick = false;
        return false;
      }
      select();
      return true;
    },
  };
};
