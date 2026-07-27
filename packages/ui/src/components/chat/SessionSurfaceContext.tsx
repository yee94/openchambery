import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

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

/** Lightweight snapshot for surface-owned sent-message edit; avoids UI→Zustand coupling. */
export type SessionSurfaceMessageEditSnapshot = {
    info: Message;
    parts: Part[];
};

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
    /**
     * Hosted surfaces (Assistant continuous) stage a sent-message edit into the
     * surface draft partition and keep primary stagedMessageEdit untouched.
     */
    onEditMessage?: (messageId: string, snapshot: SessionSurfaceMessageEditSnapshot) => Promise<void>;
    /**
     * Hosted surfaces (Assistant) jump from a stitched reply into the underlying
     * OpenCode session so the user can continue that turn outside the Assistant tab.
     */
    openSourceSession?: (sessionId: string, directory: string) => void;
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

export const createExplicitSessionSurface = (input: {
    sessionId: string | null;
    directory: string | null;
    viewKey: string;
    active: boolean;
}): SessionSurfaceContextValue => ({
    kind: 'primary',
    surfaceId: `explicit:${input.viewKey}`,
    sessionId: input.sessionId,
    directory: input.directory,
    active: input.active,
    capabilities: input.active
        ? PRIMARY_SESSION_SURFACE_CAPABILITIES
        : STRICT_READ_ONLY_SESSION_SURFACE_CAPABILITIES,
});

export const SessionSurfaceContext = React.createContext<SessionSurfaceContextValue>(PRIMARY_SESSION_SURFACE);

export const useSessionSurface = (): SessionSurfaceContextValue => React.useContext(SessionSurfaceContext);

export const getSessionSurfaceActionAvailability = (surface: SessionSurfaceContextValue) => ({
    fork: surface.capabilities.forkSession,
    revert: surface.capabilities.mutateSession,
    edit: surface.capabilities.mutateSession,
    reviewTransfer: surface.capabilities.mutateSession,
    timeline: surface.capabilities.openTimeline,
    textSelectionMutation: surface.capabilities.textSelectionActions,
    openSourceSession: Boolean(surface.openSourceSession),
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
