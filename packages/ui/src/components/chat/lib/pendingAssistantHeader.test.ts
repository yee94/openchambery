import { describe, expect, test } from 'vitest';

import {
    readUserMessageHeaderIdentity,
    resolvePendingAssistantHeader,
    shouldShowPendingAssistantHeader,
} from './pendingAssistantHeader';

const workingGap = {
    isLastTurn: true,
    sessionIsWorking: true,
    hasAssistantMessages: false,
    activityPresentationKind: 'default',
    hasActiveStreamingMessage: false,
};

describe('shouldShowPendingAssistantHeader', () => {
    test('shows while the last working turn has no assistant yet', () => {
        expect(shouldShowPendingAssistantHeader(workingGap)).toBe(true);
    });

    test('hides once an assistant row exists or the session is idle', () => {
        expect(shouldShowPendingAssistantHeader({ ...workingGap, hasAssistantMessages: true })).toBe(false);
        expect(shouldShowPendingAssistantHeader({ ...workingGap, sessionIsWorking: false })).toBe(false);
        expect(shouldShowPendingAssistantHeader({ ...workingGap, isLastTurn: false })).toBe(false);
    });

    test('leaves compaction and a still-streaming previous turn alone', () => {
        expect(shouldShowPendingAssistantHeader({
            ...workingGap,
            activityPresentationKind: 'compaction',
        })).toBe(false);
        expect(shouldShowPendingAssistantHeader({
            ...workingGap,
            hasActiveStreamingMessage: true,
        })).toBe(false);
    });
});

describe('readUserMessageHeaderIdentity', () => {
    test('reads optimistic send identity including model.variant', () => {
        expect(readUserMessageHeaderIdentity({
            agent: 'orchestrator',
            providerID: 'zai',
            modelID: 'glm-5.3',
            model: { variant: 'high' },
        })).toEqual({
            agentName: 'orchestrator',
            providerId: 'zai',
            modelId: 'glm-5.3',
            variant: 'high',
        });
    });

    test('prefers mode over agent and ignores empty strings', () => {
        expect(readUserMessageHeaderIdentity({
            mode: 'build',
            agent: 'orchestrator',
            providerID: '  ',
            modelID: 'claude-sonnet-4-5',
        })).toEqual({
            agentName: 'build',
            providerId: undefined,
            modelId: 'claude-sonnet-4-5',
            variant: undefined,
        });
    });

    test('returns null when the user row has no header identity', () => {
        expect(readUserMessageHeaderIdentity({ role: 'user' })).toBeNull();
        expect(readUserMessageHeaderIdentity(null)).toBeNull();
    });
});

describe('resolvePendingAssistantHeader', () => {
    test('humanizes the model id without waiting on the catalog', () => {
        expect(resolvePendingAssistantHeader({
            agentName: 'build',
            providerId: 'anthropic',
            modelId: 'claude-sonnet-4-5',
        })).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-5',
            agentName: 'build',
            modelName: 'Claude Sonnet 4.5',
            variant: undefined,
        });
    });

    test('falls through to the generic Assistant label when identity is missing', () => {
        expect(resolvePendingAssistantHeader(null)).toEqual({
            providerID: null,
            modelID: null,
            agentName: undefined,
            modelName: undefined,
            variant: undefined,
        });
    });
});
