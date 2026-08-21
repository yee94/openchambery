import { describe, expect, test } from 'bun:test';

import { composerSendPhase } from '@/sync/composer-send-manager';
import { resolveChatPromptAvailability, resolveComposerActionAvailability, resolveSessionIdentityPending, resolveSubagentReadOnlyBannerLatch } from './chatPromptAvailability';

const idlePhase = composerSendPhase(null, false);

describe('resolveSessionIdentityPending', () => {
    test('blocks primary chat while identity is still unproven', () => {
        expect(resolveSessionIdentityPending({
            sessionId: 'ses_1',
            hasSessionEntity: false,
            hasRenderableSessionSnapshot: false,
            composerSurfaceKind: 'primary',
        })).toBe(true);
        expect(resolveSessionIdentityPending({
            sessionId: 'ses_1',
            hasSessionEntity: false,
        })).toBe(true);
    });

    test('unblocks once the directory session entity exists', () => {
        expect(resolveSessionIdentityPending({
            sessionId: 'ses_1',
            hasSessionEntity: true,
            hasRenderableSessionSnapshot: false,
            composerSurfaceKind: 'primary',
        })).toBe(false);
    });

    test('unblocks once a renderable message snapshot proves the session', () => {
        // List/index lag must not permanently disable Send after messages paint.
        expect(resolveSessionIdentityPending({
            sessionId: 'ses_1',
            hasSessionEntity: false,
            hasRenderableSessionSnapshot: true,
            composerSurfaceKind: 'primary',
        })).toBe(false);
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

describe('resolveSubagentReadOnlyBannerLatch', () => {
    const parent = { id: 'ses_parent', directory: '/repo' };
    const viewKey = 'explicit:runtime:["/repo","ses_child"]';
    const execution = { agentName: 'explorer', providerId: 'opencode', modelId: 'grok-4.6' };

    test('keeps confirmed subagent footer ownership and execution identity across temporary session identity gaps', () => {
        const confirmed = resolveSubagentReadOnlyBannerLatch(null, viewKey, parent, execution);
        const duringGap = resolveSubagentReadOnlyBannerLatch(confirmed, viewKey, null, {});
        const afterRecovery = resolveSubagentReadOnlyBannerLatch(duringGap, viewKey, parent, {
            agentName: 'explorer',
            providerId: 'opencode',
            modelId: 'grok-4.6',
        });

        expect(confirmed).toEqual({ viewKey, parentTarget: parent, execution });
        expect(duringGap).toEqual({ viewKey, parentTarget: parent, execution });
        expect(duringGap).toBe(confirmed);
        expect(afterRecovery).toEqual({ viewKey, parentTarget: parent, execution });
        expect(afterRecovery).toBe(duringGap);
        expect(resolveSubagentReadOnlyBannerLatch(confirmed, 'other-view', null, execution)).toBeNull();
        expect(resolveSubagentReadOnlyBannerLatch(confirmed, viewKey, { ...parent }, execution)).toBe(confirmed);
    });

    test('preserves last-known execution fields when a later snapshot omits identity', () => {
        const confirmed = resolveSubagentReadOnlyBannerLatch(null, viewKey, parent, execution);
        const duringStream = resolveSubagentReadOnlyBannerLatch(confirmed, viewKey, parent, {});

        expect(duringStream?.execution).toEqual(execution);
    });
});

describe('resolveComposerActionAvailability', () => {
    test('disables Send and Queue visibly while submission is blocked', () => {
        expect(resolveComposerActionAvailability({
            canSend: true,
            hasSessionTarget: true,
            draftSubmitting: false,
            submissionBlocked: true,
            sendPhase: idlePhase,
            queueFrozen: false,
            queueFallbackAvailable: false,
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
            sendPhase: idlePhase,
            queueFrozen: true,
            queueFallbackAvailable: false,
        })).toEqual({
            sendDisabled: false,
            queueDisabled: true,
            disabledClass: 'opacity-30 pointer-events-none',
        });
    });

    test('keeps Send and Queue available while an earlier server admission is pending', () => {
        expect(resolveComposerActionAvailability({
            canSend: true,
            hasSessionTarget: true,
            draftSubmitting: false,
            submissionBlocked: false,
            sendPhase: idlePhase,
            queueFrozen: false,
            queueFallbackAvailable: false,
        })).toEqual({
            sendDisabled: false,
            queueDisabled: false,
            disabledClass: 'opacity-30 pointer-events-none',
        });
    });

    test('keeps Send and Queue available for an acknowledged admission shadow', () => {
        expect(resolveComposerActionAvailability({
            canSend: true,
            hasSessionTarget: true,
            draftSubmitting: false,
            submissionBlocked: false,
            sendPhase: idlePhase,
            queueFrozen: false,
            queueFallbackAvailable: false,
        })).toEqual({
            sendDisabled: false,
            queueDisabled: false,
            disabledClass: 'opacity-30 pointer-events-none',
        });
    });

    test('keeps busy submit available through steer while queue ownership is frozen', () => {
        expect(resolveComposerActionAvailability({
            canSend: true,
            hasSessionTarget: true,
            draftSubmitting: false,
            submissionBlocked: false,
            sendPhase: idlePhase,
            queueFrozen: true,
            queueFallbackAvailable: true,
        })).toEqual({
            sendDisabled: false,
            queueDisabled: false,
            disabledClass: 'opacity-30 pointer-events-none',
        });
    });

    test('disables Send and Queue while a component-level submission flight is active', () => {
        expect(resolveComposerActionAvailability({
            canSend: true,
            hasSessionTarget: true,
            draftSubmitting: false,
            submissionBlocked: false,
            sendPhase: composerSendPhase('send', false),
            queueFrozen: false,
            queueFallbackAvailable: false,
        })).toEqual({
            sendDisabled: true,
            queueDisabled: true,
            disabledClass: 'opacity-30 pointer-events-none',
        });
    });

    test('keeps Send available during new-session establishing follow-up admission', () => {
        expect(resolveComposerActionAvailability({
            canSend: true,
            hasSessionTarget: true,
            draftSubmitting: true,
            submissionBlocked: false,
            sendPhase: composerSendPhase('send', true),
            queueFrozen: false,
            queueFallbackAvailable: false,
        })).toEqual({
            sendDisabled: false,
            queueDisabled: false,
            disabledClass: 'opacity-30 pointer-events-none',
        });
    });

    test('treats an idle send phase as not in flight', () => {
        expect(resolveComposerActionAvailability({
            canSend: true,
            hasSessionTarget: true,
            draftSubmitting: false,
            submissionBlocked: false,
            sendPhase: idlePhase,
            queueFrozen: false,
            queueFallbackAvailable: false,
        })).toEqual({
            sendDisabled: false,
            queueDisabled: false,
            disabledClass: 'opacity-30 pointer-events-none',
        });
    });
});
