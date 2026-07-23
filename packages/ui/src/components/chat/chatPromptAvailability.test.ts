import { describe, expect, test } from 'bun:test';

import { resolveChatPromptAvailability, resolveComposerActionAvailability, resolveSessionIdentityPending } from './chatPromptAvailability';

describe('resolveSessionIdentityPending', () => {
    test('blocks primary chat while the directory session entity is missing', () => {
        expect(resolveSessionIdentityPending({
            sessionId: 'ses_1',
            hasSessionEntity: false,
            composerSurfaceKind: 'primary',
        })).toBe(true);
        expect(resolveSessionIdentityPending({
            sessionId: 'ses_1',
            hasSessionEntity: false,
        })).toBe(true);
    });

    test('does not block hosted Assistant secondary surfaces on a missing list entity', () => {
        // Share/new rebinds often land before the managed workspace index has the row.
        expect(resolveSessionIdentityPending({
            sessionId: 'ses_share',
            hasSessionEntity: false,
            composerSurfaceKind: 'secondary',
        })).toBe(false);
        expect(resolveSessionIdentityPending({
            sessionId: 'ses_share',
            hasSessionEntity: true,
            composerSurfaceKind: 'secondary',
        })).toBe(false);
    });

    test('is not pending without a session id', () => {
        expect(resolveSessionIdentityPending({
            sessionId: null,
            hasSessionEntity: false,
            composerSurfaceKind: 'primary',
        })).toBe(false);
    });
});

describe('resolveChatPromptAvailability', () => {
    test('keeps the primary composer mounted while session identity is temporarily pending', () => {
        expect(resolveChatPromptAvailability({
            readOnly: false,
            sessionIdentityPending: true,
            isSubagentSession: false,
            allowPromptingSubagentSessions: false,
        })).toEqual({
            showReadOnlyBanner: false,
            blockSubmission: true,
        });
    });

    test('shows the read-only banner only for confirmed subagent sessions', () => {
        expect(resolveChatPromptAvailability({
            readOnly: false,
            sessionIdentityPending: false,
            isSubagentSession: true,
            allowPromptingSubagentSessions: false,
        }).showReadOnlyBanner).toBe(true);
        expect(resolveChatPromptAvailability({
            readOnly: true,
            sessionIdentityPending: false,
            isSubagentSession: false,
            allowPromptingSubagentSessions: true,
        }).showReadOnlyBanner).toBe(false);
        expect(resolveChatPromptAvailability({
            readOnly: true,
            sessionIdentityPending: true,
            isSubagentSession: false,
            allowPromptingSubagentSessions: false,
        }).showReadOnlyBanner).toBe(false);
    });

    test('keeps prompting available for known primary sessions and enabled subagent sessions', () => {
        expect(resolveChatPromptAvailability({
            readOnly: false,
            sessionIdentityPending: false,
            isSubagentSession: false,
            allowPromptingSubagentSessions: false,
        })).toEqual({
            showReadOnlyBanner: false,
            blockSubmission: false,
        });
        expect(resolveChatPromptAvailability({
            readOnly: false,
            sessionIdentityPending: false,
            isSubagentSession: true,
            allowPromptingSubagentSessions: true,
        })).toEqual({
            showReadOnlyBanner: false,
            blockSubmission: false,
        });
    });
});

describe('resolveComposerActionAvailability', () => {
    test('disables Send and Queue visibly while submission is blocked', () => {
        expect(resolveComposerActionAvailability({
            canSend: true,
            hasSessionTarget: true,
            draftSubmitting: false,
            submissionBlocked: true,
            queueFrozen: false,
            hasBlockingAdmission: false,
        })).toEqual({
            sendDisabled: true,
            queueDisabled: true,
            disabledClass: 'opacity-30 pointer-events-none',
        });
    });

    test('disables Queue visibly while queue admission is frozen', () => {
        expect(resolveComposerActionAvailability({
            canSend: true,
            hasSessionTarget: true,
            draftSubmitting: false,
            submissionBlocked: false,
            queueFrozen: true,
            hasBlockingAdmission: false,
        })).toEqual({
            sendDisabled: false,
            queueDisabled: true,
            disabledClass: 'opacity-30 pointer-events-none',
        });
    });

    test('disables Send and Queue while server admission is blocking', () => {
        expect(resolveComposerActionAvailability({
            canSend: true,
            hasSessionTarget: true,
            draftSubmitting: false,
            submissionBlocked: false,
            queueFrozen: false,
            hasBlockingAdmission: true,
        })).toEqual({
            sendDisabled: true,
            queueDisabled: true,
            disabledClass: 'opacity-30 pointer-events-none',
        });
    });

    test('keeps Send and Queue available for an acknowledged admission shadow', () => {
        expect(resolveComposerActionAvailability({
            canSend: true,
            hasSessionTarget: true,
            draftSubmitting: false,
            submissionBlocked: false,
            queueFrozen: false,
            hasBlockingAdmission: false,
        })).toEqual({
            sendDisabled: false,
            queueDisabled: false,
            disabledClass: 'opacity-30 pointer-events-none',
        });
    });
});
