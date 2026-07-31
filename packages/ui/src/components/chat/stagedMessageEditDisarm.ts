/**
 * A staged message edit turns the next send into "delete this turn, then resend", so
 * it must not outlive the user's intent — a forgotten one deletes a turn on some later
 * unrelated send.
 *
 * Only the user releases it: the ✕ on the message row, leaving the session, or moving
 * focus out of the composer. An empty composer deliberately does *not* count. Dispatch
 * clears the composer on every send, so "empty" fires in the middle of the edit's own
 * submit, and a cleared draft is not an abandoned edit either way.
 *
 * Blur alone is too noisy to act on, hence the guards below: each one is a blur that
 * does not mean "the user walked away from this edit".
 */
export type StagedEditDisarmDecision =
    | { action: 'keep' }
    | { action: 'disarm'; sessionId: string };

export const resolveStagedEditBlurDisarm = (input: {
    surfaceKind: 'primary' | 'secondary';
    stagedSessionId: string | null;
    /** Staged row read back *after* the blur settles, to catch a re-stage. */
    stagedMessageId: string | null;
    /** Staged row as it was when the blur fired. */
    blurredMessageId: string | null;
    submitInFlight: boolean;
    /** Mobile holds focus across overlay close / keyboard restore windows. */
    focusHeld: boolean;
    overlayOpen: boolean;
    focusInsideComposer: boolean;
}): StagedEditDisarmDecision => {
    // Secondary surfaces own their own staged-edit scope; nothing to release here.
    if (input.surfaceKind !== 'primary') return { action: 'keep' };
    if (!input.stagedSessionId || !input.stagedMessageId) return { action: 'keep' };
    // Editing a second row blurs the composer before re-staging: that blur belongs to
    // the edit being replaced, and acting on it would cancel the incoming one.
    if (input.stagedMessageId !== input.blurredMessageId) return { action: 'keep' };
    // Submitting this very edit — desktop moves focus to the send button.
    if (input.submitInFlight) return { action: 'keep' };
    if (input.focusHeld || input.overlayOpen) return { action: 'keep' };
    // Attach / model / dictation controls live in composer chrome, not outside it.
    if (input.focusInsideComposer) return { action: 'keep' };
    return { action: 'disarm', sessionId: input.stagedSessionId };
};
