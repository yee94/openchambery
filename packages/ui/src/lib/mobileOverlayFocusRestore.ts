// Overlay focus restoration returns the user to whatever they were doing before
// an overlay opened. Selecting a session is navigation instead: the composer the
// user may have been typing in belongs to the previous conversation, so its
// keyboard must not come back up over the newly opened one. Session switch
// handlers arm this suppression right before closing their overlay; every
// overlay focus/keyboard restore site honors it for a short window that covers
// the close animation and the debounced composer restore.
export const SUPPRESS_WINDOW_MS = 800;

let suppressedUntil = 0;

export const suppressMobileOverlayFocusRestore = (): void => {
    suppressedUntil = Date.now() + SUPPRESS_WINDOW_MS;
};

export const isMobileOverlayFocusRestoreSuppressed = (): boolean => Date.now() < suppressedUntil;
