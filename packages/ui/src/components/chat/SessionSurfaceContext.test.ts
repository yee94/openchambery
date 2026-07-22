import { describe, expect, test } from 'bun:test';

import {
    PRIMARY_SESSION_SURFACE,
    STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES,
    getSessionSurfaceActionAvailability,
    navigateNestedSession,
    type SessionSurfaceContextValue,
} from './SessionSurfaceContext';

describe('SessionSurfaceContext', () => {
    test('uses the active primary surface with every capability enabled by default', () => {
        expect(PRIMARY_SESSION_SURFACE).toEqual({
            kind: 'primary',
            surfaceId: 'primary',
            sessionId: null,
            directory: null,
            active: true,
            capabilities: {
                compose: true,
                mutateSession: true,
                answerRequests: true,
                openTimeline: true,
                navigateNestedSession: true,
                textSelectionActions: true,
                forkSession: true,
            },
        });
    });

    test('defines strict read-only capabilities', () => {
        expect(STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES).toEqual({
            compose: false,
            mutateSession: false,
            answerRequests: false,
            openTimeline: false,
            navigateNestedSession: true,
            textSelectionActions: false,
            forkSession: false,
        });
    });

    test('uses a panel nested-session callback before legacy session switching', () => {
        const calls: string[] = [];
        const surface: SessionSurfaceContextValue = {
            ...PRIMARY_SESSION_SURFACE,
            kind: 'panel',
            surfaceId: 'panel',
            sessionId: 'parent',
            directory: '/workspace',
            navigateSession: (sessionId, directory) => calls.push(`surface:${sessionId}:${directory}`),
        };

        const opened = navigateNestedSession(surface, 'child', '/workspace', () => calls.push('setCurrentSession'));

        expect(opened).toBe(true);
        expect(calls).toEqual(['surface:child:/workspace']);
    });

    test('keeps primary nested-session navigation on the legacy path', () => {
        const calls: string[] = [];

        expect(navigateNestedSession(PRIMARY_SESSION_SURFACE, 'child', '/workspace', () => calls.push('setCurrentSession'))).toBe(true);
        expect(calls).toEqual(['setCurrentSession']);
    });

    test('keeps nested navigation within a strict surface callback', () => {
        const calls: string[] = [];
        const surface: SessionSurfaceContextValue = {
            kind: 'panel',
            surfaceId: 'strict-panel',
            sessionId: 'parent',
            directory: '/workspace',
            active: true,
            capabilities: STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES,
        };

        expect(navigateNestedSession(surface, 'child', '/workspace', () => calls.push('setCurrentSession'))).toBe(false);
        expect(calls).toEqual([]);
    });

    test('blocks every nested navigation path when navigation is disabled', () => {
        const calls: string[] = [];
        const surface: SessionSurfaceContextValue = {
            ...PRIMARY_SESSION_SURFACE,
            capabilities: {
                ...PRIMARY_SESSION_SURFACE.capabilities,
                navigateNestedSession: false,
            },
            navigateSession: () => calls.push('navigateSession'),
        };

        expect(navigateNestedSession(surface, 'child', '/workspace', () => calls.push('setCurrentSession'))).toBe(false);
        expect(calls).toEqual([]);
    });

    test('removes strict read-only mutation entry points', () => {
        expect(getSessionSurfaceActionAvailability({
            kind: 'panel',
            surfaceId: 'strict-panel',
            sessionId: 'parent',
            directory: '/workspace',
            active: true,
            capabilities: STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES,
        })).toEqual({
            fork: false,
            revert: false,
            edit: false,
            reviewTransfer: false,
            timeline: false,
            textSelectionMutation: false,
            openSourceSession: false,
        });
    });

    test('allows hosted surfaces to carry a custom revert handler', () => {
        const onRevertMessage = async () => {};
        const surface: SessionSurfaceContextValue = {
            kind: 'embedded',
            surfaceId: 'assistant:test',
            sessionId: 'ses_test',
            directory: '/workspace',
            active: true,
            capabilities: PRIMARY_SESSION_SURFACE.capabilities,
            onRevertMessage,
        };

        expect(surface.onRevertMessage).toBe(onRevertMessage);
        expect(getSessionSurfaceActionAvailability(surface).revert).toBe(true);
    });

    test('exposes openSourceSession only when the host provides a jump handler', () => {
        const openSourceSession = () => {};
        const surface: SessionSurfaceContextValue = {
            kind: 'embedded',
            surfaceId: 'assistant:test',
            sessionId: 'ses_test',
            directory: '/workspace',
            active: true,
            capabilities: PRIMARY_SESSION_SURFACE.capabilities,
            openSourceSession,
        };

        expect(surface.openSourceSession).toBe(openSourceSession);
        expect(getSessionSurfaceActionAvailability(surface).openSourceSession).toBe(true);
        expect(getSessionSurfaceActionAvailability(PRIMARY_SESSION_SURFACE).openSourceSession).toBe(false);
    });
});
