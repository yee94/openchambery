/** Place a focused session row about one-third down the sidebar viewport. */
export const FOCUSED_SESSION_ROW_VIEWPORT_RATIO = 1 / 3;

const MIN_SCROLL_DELTA_PX = 1;

export const getFocusedSessionRowScrollTop = ({
  containerScrollTop,
  containerClientHeight,
  containerScrollHeight,
  rowOffsetFromViewportTop,
}: {
  containerScrollTop: number;
  containerClientHeight: number;
  containerScrollHeight: number;
  rowOffsetFromViewportTop: number;
}): number => {
  const targetOffset = containerClientHeight * FOCUSED_SESSION_ROW_VIEWPORT_RATIO;
  const next = containerScrollTop + (rowOffsetFromViewportTop - targetOffset);
  const maxScroll = Math.max(0, containerScrollHeight - containerClientHeight);
  return Math.min(maxScroll, Math.max(0, next));
};

const getFocusedSessionRowScrollBehavior = (): ScrollBehavior => {
  if (typeof window === 'undefined') {
    return 'auto';
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
};

const findSidebarScrollContainer = (node: HTMLElement): HTMLElement | null => {
  const overlay = node.closest<HTMLElement>('.overlay-scrollbar-target');
  if (overlay) {
    return overlay;
  }

  let el: HTMLElement | null = node.parentElement;
  while (el && el !== document.body) {
    const overflowY = window.getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      return el;
    }
    el = el.parentElement;
  }
  return null;
};

export const scrollFocusedSessionRowIntoView = (
  row: HTMLElement,
  options?: { behavior?: ScrollBehavior },
): void => {
  const container = findSidebarScrollContainer(row);
  const behavior = options?.behavior ?? getFocusedSessionRowScrollBehavior();
  if (!container) {
    row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
    return;
  }

  const nextTop = getFocusedSessionRowScrollTop({
    containerScrollTop: container.scrollTop,
    containerClientHeight: container.clientHeight,
    containerScrollHeight: container.scrollHeight,
    rowOffsetFromViewportTop: row.getBoundingClientRect().top - container.getBoundingClientRect().top,
  });
  if (Math.abs(nextTop - container.scrollTop) < MIN_SCROLL_DELTA_PX) {
    return;
  }
  container.scrollTo({ top: nextTop, behavior });
};
