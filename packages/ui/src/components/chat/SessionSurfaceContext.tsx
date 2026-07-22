import React from 'react';

export interface SessionSurfaceCapabilities {
    compose: boolean;
    mutateSession: boolean;
    answerRequests: boolean;
    openTimeline: boolean;
    navigateNestedSession: boolean;
    textSelectionActions: boolean;
    forkSession: boolean;
}

export type SessionSurfaceKind = 'primary' | 'panel' | 'embedded';

export interface SessionSurfaceContextValue {
    kind: SessionSurfaceKind;
    surfaceId: string;
    sessionId: string | null;
    directory: string | null;
    active: boolean;
    capabilities: SessionSurfaceCapabilities;
    navigateSession?: (sessionId: string, directory: string) => void;
    /** Hosted surfaces (Assistant) restore into their own draft partition. */
    onRevertMessage?: (messageId: string) => Promise<void>;
}

export const PRIMARY_SESSION_SURFACE_CAPABILITIES: SessionSurfaceCapabilities = {
    compose: true,
    mutateSession: true,
    answerRequests: true,
    openTimeline: true,
    navigateNestedSession: true,
    textSelectionActions: true,
    forkSession: true,
};

export const STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES: SessionSurfaceCapabilities = {
    compose: false,
    mutateSession: false,
    answerRequests: false,
    openTimeline: false,
    navigateNestedSession: true,
    textSelectionActions: false,
    forkSession: false,
};

export const PRIMARY_SESSION_SURFACE: SessionSurfaceContextValue = {
    kind: 'primary',
    surfaceId: 'primary',
    sessionId: null,
    directory: null,
    active: true,
    capabilities: PRIMARY_SESSION_SURFACE_CAPABILITIES,
};

export const SessionSurfaceContext = React.createContext<SessionSurfaceContextValue>(PRIMARY_SESSION_SURFACE);

export const useSessionSurface = (): SessionSurfaceContextValue => React.useContext(SessionSurfaceContext);

export const getSessionSurfaceActionAvailability = (surface: SessionSurfaceContextValue) => ({
    fork: surface.capabilities.forkSession,
    revert: surface.capabilities.mutateSession,
    edit: surface.capabilities.mutateSession,
    reviewTransfer: surface.capabilities.mutateSession,
    timeline: surface.capabilities.openTimeline,
    textSelectionMutation: surface.capabilities.textSelectionActions,
});

export const navigateNestedSession = (
    surface: SessionSurfaceContextValue,
    sessionId: string,
    directory: string,
    navigateLegacy: () => void,
): boolean => {
    if (!surface.capabilities.navigateNestedSession) {
        return false;
    }

    if (surface.navigateSession) {
        surface.navigateSession(sessionId, directory);
        return true;
    }

    if (surface.kind !== 'primary') {
        return false;
    }

    navigateLegacy();
    return true;
};
