/** Visible keyboard overlap from CSS inset and the visual viewport. Never adds them. */
export const keyboardOverlapPx = (input: {
  cssInsetPx: number;
  innerHeight: number;
  visualHeight?: number;
  visualOffsetTop?: number;
}): number => {
  const cssInset = Number.isFinite(input.cssInsetPx) ? Math.max(0, input.cssInsetPx) : 0;
  const visualHeight = input.visualHeight;
  const visual = visualHeight == null || !Number.isFinite(visualHeight)
    ? 0
    : Math.max(0, input.innerHeight - visualHeight - (input.visualOffsetTop ?? 0));
  return Math.max(cssInset, visual);
};

export const parseCssPx = (value: string | null | undefined): number => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};
