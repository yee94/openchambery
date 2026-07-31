import { describe, expect, test } from 'bun:test';
import { resolveStagedEditDisarm } from './stagedMessageEditDisarm';

const staged = {
    surfaceKind: 'primary' as const,
    stagedSessionId: 'session-a',
    composerHasContent: true,
    sawComposerContent: false,
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

    test('resets when nothing is staged or the surface is secondary', () => {
        expect(resolveStagedEditDisarm({ ...staged, stagedSessionId: null })).toEqual({ action: 'reset' });
        expect(resolveStagedEditDisarm({ ...staged, surfaceKind: 'secondary' })).toEqual({ action: 'reset' });
    });
});
