const CODE_SELECTION_ACTION_SELECTOR = '[data-code-selection-action]';

function isCodeSelectionActionEventTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(CODE_SELECTION_ACTION_SELECTOR));
}

export function shouldKeepDiffSelectionActionForPointerDown(
  target: EventTarget | null,
  composedPath: readonly EventTarget[] = [],
): boolean {
  if (isCodeSelectionActionEventTarget(target)) return true;
  return composedPath.some((node) => node instanceof Element && node.matches('[data-column-number]'));
}

export function shouldDismissDiffSelectionAction(
  target: EventTarget | null,
  composedPath: readonly EventTarget[] = [],
): boolean {
  return !shouldKeepDiffSelectionActionForPointerDown(target, composedPath);
}

export function shouldShowDiffSelectionActionFromPointerUp(
  fromTextSelectionGesture: boolean,
  selectedText: string | null | undefined,
): boolean {
  return fromTextSelectionGesture && Boolean(selectedText?.trim());
}
