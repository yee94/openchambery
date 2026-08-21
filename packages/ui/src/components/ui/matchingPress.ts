type PressEvent = {
  currentTarget: EventTarget;
  target?: EventTarget | null;
  detail?: number;
};

const matchingPressOwners = new WeakMap<EventTarget, true>();

export function markMatchingPress(event: PressEvent): void {
  matchingPressOwners.set(event.currentTarget, true);
}

export function consumeMatchingPress(event: PressEvent): boolean {
  if (matchingPressOwners.delete(event.currentTarget)) return true;
  // Keyboard / accessibility activation synthesizes click with detail 0 and
  // no pointerdown. A leftover click from another control (search → IME
  // resize → retarget) must not count as activation.
  if (event.detail !== 0) return false;
  if (typeof document === 'undefined') return true;
  const active = document.activeElement;
  const owner = event.currentTarget;
  return owner instanceof Node && active instanceof Node && owner.contains(active);
}

export function markOverlayScrimPress(event: PressEvent): void {
  if (event.target !== event.currentTarget) return;
  markMatchingPress(event);
}

export function shouldCommitOverlayScrimDismiss(event: PressEvent): boolean {
  if (event.target !== event.currentTarget) return false;
  return consumeMatchingPress(event);
}
