/**
 * Whether primary submit should create a pre-await optimistic send ticket.
 * Excludes secondary surfaces, queue-only submits, resource-preserving paths,
 * shell mode, and local commands (/fork, /undo, /redo, and other local magic).
 * Ordinary remote slash prompts remain eligible when other gates pass.
 */
export const shouldOptimisticPrimarySend = (input: {
    surfaceKind: 'primary' | 'secondary';
    currentSessionId: string | null | undefined;
    queuedOnly: boolean;
    resourcePolicy: boolean;
    inputMode: 'normal' | 'shell';
    localCommand: string | null;
}): boolean => (
    input.surfaceKind === 'primary'
    && !!input.currentSessionId
    && !input.queuedOnly
    && !input.resourcePolicy
    && input.inputMode !== 'shell'
    && !input.localCommand
);
