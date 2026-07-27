import { describe, expect, test } from 'bun:test';

import {
    PRIMARY_SESSION_SURFACE,
    STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES,
    createExplicitSessionSurface,
    getSessionSurfaceActionAvailability,
    navigateNestedSession,
    type SessionSurfaceContextValue,
} from './SessionSurfaceContext';

describe('SessionSurfaceContext', () => {
    test('binds explicit predecessor and top surfaces to their own page identity', () => {
        const predecessor = createExplicitSessionSurface({
            sessionId: 'parent',
            directory: '/parent',
            viewKey: 'parent-page',
            active: false,
        });
        const top = createExplicitSessionSurface({
            sessionId: 'child',
            directory: '/child',
            viewKey: 'child-page',
            active: true,
        });

        expect(predecessor.sessionId).toBe('parent');
        expect(predecessor.directory).toBe('/parent');
        expect(predecessor.surfaceId).toBe('explicit:parent-page');
        expect(predecessor.active).toBe(false);
        expect(predecessor.capabilities).toBe(STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES);
        expect(top.sessionId).toBe('child');
        expect(top.directory).toBe('/child');
        expect(top.surfaceId).toBe('explicit:child-page');
        expect(top.active).toBe(true);
        expect(top.capabilities.compose).toBe(true);
    });
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

    test('allows hosted surfaces to carry a custom sent-message edit handler', () => {
        const onEditMessage = async () => {};
        const surface: SessionSurfaceContextValue = {
            kind: 'embedded',
            surfaceId: 'assistant:test',
            sessionId: 'ses_test',
            directory: '/workspace',
            active: true,
            capabilities: PRIMARY_SESSION_SURFACE.capabilities,
            onEditMessage,
        };

        expect(surface.onEditMessage).toBe(onEditMessage);
        expect(getSessionSurfaceActionAvailability(surface).edit).toBe(true);
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
