/**
 * A staged message edit turns the next send into "delete this turn, then resend".
 * Emptying the composer throws the restored text away, so the staged edit must be
 * disarmed — otherwise an unrelated later send deletes a turn the user forgot about.
 *
 * `sawComposerContent` gates the transition: staging restores the old text a render
 * before the composer state lands, so an empty composer only disarms once content
 * has actually been observed.
 *
 * `submitInFlight` gates the other direction: dispatch itself empties the composer
 * before the send reaches the commit, and disarming there would drop the very edit
 * being submitted — the turn survives, the resend lands as a new message, and the
 * commit paint is never released.
 */
export type StagedEditDisarmDecision =
    | { action: 'reset' }
    | { action: 'arm' }
    | { action: 'hold' }
    | { action: 'disarm'; sessionId: string };

export const resolveStagedEditDisarm = (input: {
    surfaceKind: 'primary' | 'secondary';
    stagedSessionId: string | null;
    composerHasContent: boolean;
    sawComposerContent: boolean;
    submitInFlight: boolean;
}): StagedEditDisarmDecision => {
    // Secondary surfaces own their own staged-edit scope; nothing to track here.
    if (input.surfaceKind !== 'primary' || !input.stagedSessionId) return { action: 'reset' };
    if (input.submitInFlight) return { action: 'hold' };
    if (input.composerHasContent) return { action: 'arm' };
    if (!input.sawComposerContent) return { action: 'hold' };
    return { action: 'disarm', sessionId: input.stagedSessionId };
};