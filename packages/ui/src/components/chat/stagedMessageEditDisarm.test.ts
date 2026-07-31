import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveStagedEditDisarm } from './stagedMessageEditDisarm';

const chatInputSource = readFileSync(join(__dirname, 'ChatInput.tsx'), 'utf-8');

const staged = {
    surfaceKind: 'primary' as const,
    stagedSessionId: 'session-a',
    composerHasContent: true,
    sawComposerContent: false,
    submitInFlight: false,
};

describe('resolveStagedEditDisarm', () => {
    test('arms once the restored composer content is observed', () => {
        expect(resolveStagedEditDisarm(staged)).toEqual({ action: 'arm' });
    });

    test('holds while the composer is still empty right after staging', () => {
        expect(resolveStagedEditDisarm({ ...staged, composerHasContent: false })).toEqual({ action: 'hold' });
    });

    test('disarms when an armed composer is emptied', () => {
        expect(resolveStagedEditDisarm({ ...staged, composerHasContent: false, sawComposerContent: true }))
            .toEqual({ action: 'disarm', sessionId: 'session-a' });
    });

    test('holds while a submit is in flight so dispatch clearing the composer cannot disarm', () => {
        expect(resolveStagedEditDisarm({
            ...staged,
            composerHasContent: false,
            sawComposerContent: true,
            submitInFlight: true,
        })).toEqual({ action: 'hold' });
    });

    test('resets when nothing is staged or the surface is secondary', () => {
        expect(resolveStagedEditDisarm({ ...staged, stagedSessionId: null })).toEqual({ action: 'reset' });
        expect(resolveStagedEditDisarm({ ...staged, surfaceKind: 'secondary' })).toEqual({ action: 'reset' });
    });
});

describe('ChatInput staged-edit wiring', () => {
    test('feeds submit flight into the disarm decision', () => {
        expect(chatInputSource).toContain('submitInFlight: submissionFlightKind !== null');
    });

    test('focuses the composer when a staged edit arms', () => {
        expect(chatInputSource).toContain('const armedNow = decision.action === \'arm\' && !stagedEditSawContentRef.current');
        expect(chatInputSource).toContain('if (armedNow && !focusComposerTextarea(textareaRef))');
    });

    test('releases the editing paint when the send settles, not only on commit', () => {
        const settleStart = chatInputSource.indexOf('void sendPromise.finally(() => {');
        const settleHandler = chatInputSource.slice(settleStart, chatInputSource.indexOf('});', settleStart));
        expect(settleHandler).toContain('endMessageEditCommit(');
    });
});