import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveStagedEditBlurDisarm } from './stagedMessageEditDisarm';

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

    test('commits a staged edit before queue admission so a queued resend stays a replacement', () => {
        const queueStart = chatInputSource.indexOf('const handleQueueMessage = useEvent(async () => {');
        const queueHandler = chatInputSource.slice(queueStart, chatInputSource.indexOf('const inputSnapshot = getCurrentInputSnapshot();', queueStart));
        expect(queueHandler).toContain('commitMessageEdit(');
        expect(queueHandler).toContain('beginMessageEditCommit(');
        expect(queueHandler).toContain('endMessageEditCommit(');
        expect(queueHandler).toContain('clearStagedMessageEdit(');
    });

    test('treats the whole composer shell and chrome-action windows as still inside the composer', () => {
        expect(chatInputSource).toContain('active.closest(\'[data-composer-content="true"]\')');
        expect(chatInputSource).toContain('Date.now() < suppressComposerFocusUntilRef.current');
        expect(chatInputSource).not.toContain('active.closest(\'[data-chat-input="true"]\') || active.closest(\'[data-chat-input-footer');
    });
});
