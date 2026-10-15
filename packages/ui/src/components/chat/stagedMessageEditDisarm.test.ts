import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { resolveStagedEditBlurDisarm } from './stagedMessageEditDisarm';
import { resolveFollowUpEnterAction } from './followUpShortcut';
import { shouldRouteComposerThroughQueue } from './queueAdmission';

const chatInputSource = readFileSync(join(__dirname, 'ChatInput.tsx'), 'utf-8');

const blurred = {
    surfaceKind: 'primary' as const,
    stagedSessionId: 'session-a',
    stagedMessageId: 'msg-1',
    blurredMessageId: 'msg-1',
    submitInFlight: false,
    focusHeld: false,
    overlayOpen: false,
    focusInsideComposer: false,
};

describe('resolveStagedEditBlurDisarm', () => {
    test('disarms when focus leaves the composer entirely', () => {
        expect(resolveStagedEditBlurDisarm(blurred)).toEqual({ action: 'disarm', sessionId: 'session-a' });
    });

    test('keeps the edit when focus stays in composer chrome', () => {
        expect(resolveStagedEditBlurDisarm({ ...blurred, focusInsideComposer: true })).toEqual({ action: 'keep' });
    });

    test('keeps the edit while its own submit is in flight', () => {
        expect(resolveStagedEditBlurDisarm({ ...blurred, submitInFlight: true })).toEqual({ action: 'keep' });
    });

    test('keeps the edit across held-focus and overlay windows', () => {
        expect(resolveStagedEditBlurDisarm({ ...blurred, focusHeld: true })).toEqual({ action: 'keep' });
        expect(resolveStagedEditBlurDisarm({ ...blurred, overlayOpen: true })).toEqual({ action: 'keep' });
    });

    test('keeps the incoming edit when another row re-staged during the blur', () => {
        expect(resolveStagedEditBlurDisarm({ ...blurred, stagedMessageId: 'msg-2' })).toEqual({ action: 'keep' });
    });

    test('keeps when nothing is staged or the surface is secondary', () => {
        expect(resolveStagedEditBlurDisarm({ ...blurred, stagedSessionId: null, stagedMessageId: null }))
            .toEqual({ action: 'keep' });
        expect(resolveStagedEditBlurDisarm({ ...blurred, surfaceKind: 'secondary' })).toEqual({ action: 'keep' });
    });
});

describe('ChatInput staged-edit wiring', () => {
    test('an empty composer is no longer a cancel signal', () => {
        expect(chatInputSource).not.toContain('sawComposerContent');
        expect(chatInputSource).not.toContain('composerHasContent');
    });

    test('releases the staged edit from the composer blur handler', () => {
        expect(chatInputSource).toContain('releaseStagedEditOnComposerBlur();');
        expect(chatInputSource).toContain('resolveStagedEditBlurDisarm({');
    });

    test('focuses the composer once per staged row', () => {
        expect(chatInputSource).toContain('if (stagedEditFocusedRowRef.current === stagedEditMessageId) return;');
        expect(chatInputSource).toContain('if (!focusComposerTextarea(textareaRef))');
    });

    test('releases the editing paint when the send settles, not only on commit', () => {
        const settleStart = chatInputSource.indexOf('void sendPromise.finally(() => {');
        const settleHandler = chatInputSource.slice(settleStart, chatInputSource.indexOf('});', settleStart));
        expect(settleHandler).toContain('endMessageEditCommit(');
    });

    test('delegates staged edits to direct submission before queue admission', () => {
        const queueStart = chatInputSource.indexOf('const handleQueueMessage = useEvent(async () => {');
        const queueHandler = chatInputSource.slice(queueStart, chatInputSource.indexOf('const inputSnapshot = getCurrentInputSnapshot();', queueStart));
        expect(queueHandler).toContain('await handleSubmitRef.current();');
        expect(queueHandler).not.toContain('commitMessageEdit(');
    });

    test('defers the primary optimistic ticket until the staged edit is committed', () => {
        const gate = chatInputSource.indexOf('if (!messageEditCommitTarget && optimisticConfig?.providerID && optimisticConfig?.modelID)');
        const admission = chatInputSource.indexOf('optimisticTicket = sessionActions.beginOptimisticSend(');
        expect(gate).toBeGreaterThan(0);
        expect(gate).toBeLessThan(admission);
    });

    test('treats the whole composer shell and chrome-action windows as still inside the composer', () => {
        expect(chatInputSource).toContain('active.closest(\'[data-composer-content="true"]\')');
        expect(chatInputSource).toContain('Date.now() < suppressComposerFocusUntilRef.current');
        expect(chatInputSource).not.toContain('active.closest(\'[data-chat-input="true"]\') || active.closest(\'[data-chat-input-footer');
    });
});

describe('sent-message edit submission routing', () => {
    // Execute the actual entry and submission routing with external resources stubbed.
    // This catches a correct helper wired after queue routing or bypassed by Send.
    const primaryStart = chatInputSource.indexOf('const handlePrimaryAction = useEvent(() => {');
    const primary = chatInputSource.slice(primaryStart, chatInputSource.indexOf('\n    });', primaryStart) + 8);
    const routingStart = chatInputSource.indexOf('const queuedOnly = options?.queuedOnly ?? false;');
    const routing = chatInputSource.slice(routingStart, chatInputSource.indexOf('const queuedMessagesToSend =', routingStart));

    async function submit(input: { editing: boolean; busy: boolean; queued: boolean; shortcut?: boolean; frozen?: boolean }) {
        const sent: unknown[] = [];
        let enqueued = 0;
        const context = {
            useEvent: (fn: unknown) => fn,
            useSessionUIStore: { getState: () => ({ stagedMessageEdit: input.editing ? { sessionId: 'session-a', messageId: 'msg_1' } : null }) },
            currentSessionId: 'session-a', surface: { kind: 'primary', deliveryTarget: { kind: 'primary' } },
            sessionIsRunning: input.busy, autoReviewRunning: false, hasQueuedMessages: input.queued,
            queueFrozen: input.frozen ?? false, serverQueue: { mode: 'server' }, inputMode: 'normal', followUpBehavior: 'queue',
            getCurrentInputSnapshot: () => ({ message: 'edited', document: { text: 'edited', references: [] }, hasContent: true }),
            getLocalChatCommand: () => null, claimedByEstablishingFollowUp: () => false, isSubmissionInFlight: () => false,
            queueModeAllowsMutations: () => true, assistantQueueAdmissionAvailable: () => true,
            resolveFollowUpEnterAction, shouldRouteComposerThroughQueue,
            queueMessageFromEvent: () => { enqueued++; }, captureSubmission: () => null, attachedFiles: [],
            serializeComposerDocument: () => ({ ok: true, text: 'edited', chunks: [], semantics: [] }),
            preservesComposerResources: () => false,
            record: (value: unknown) => { sent.push(value); }, shortcut: input.shortcut,
        };
        const code = `async function submit(options) { ${routing}\n record({ delivery, steerAfterAdmit }); }
            const handleSubmitRef = { current: submit };
            ${primary};
            shortcut ? submit({ steerAfterAdmit: true }) : handlePrimaryAction();`;
        await runInNewContext(transpileModule(code, { compilerOptions: { target: ScriptTarget.ESNext } }).outputText, context);
        return { sent, enqueued };
    }

    test.each([false, true])('busy edit bypasses queue, including existing queue=%s', async (queued) => {
        expect(await submit({ editing: true, busy: true, queued })).toEqual({ sent: [{ delivery: 'steer', steerAfterAdmit: false }], enqueued: 0 });
    });
    test('shortcut edit never queues before steering', async () => {
        expect(await submit({ editing: true, busy: true, queued: true, shortcut: true })).toEqual({ sent: [{ delivery: 'steer', steerAfterAdmit: false }], enqueued: 0 });
    });
    test('frozen queue does not block replacement', async () => {
        expect(await submit({ editing: true, busy: true, queued: true, frozen: true })).toEqual({ sent: [{ delivery: 'steer', steerAfterAdmit: false }], enqueued: 0 });
    });
    test('ordinary follow-ups retain native and existing queue behavior', async () => {
        expect(await submit({ editing: false, busy: true, queued: false })).toEqual({ sent: [{ delivery: 'queue', steerAfterAdmit: false }], enqueued: 0 });
        expect(await submit({ editing: false, busy: true, queued: true })).toEqual({ sent: [], enqueued: 1 });
    });
});
