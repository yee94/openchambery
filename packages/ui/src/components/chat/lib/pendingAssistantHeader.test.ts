import { describe, expect, test } from 'vitest';

import {
    readUserMessageHeaderIdentity,
    resolveAssistantHeaderModel,
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

    test('reads official ModelRef id and prompt metadata', () => {
        expect(readUserMessageHeaderIdentity({
            agent: 'build',
            model: { id: 'gpt-5.6', providerID: 'openai', variant: 'high' },
        })).toEqual({
            agentName: 'build',
            providerId: 'openai',
            modelId: 'gpt-5.6',
            variant: 'high',
        });
        expect(readUserMessageHeaderIdentity({
            metadata: {
                agent: 'build',
                model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
            },
        })).toMatchObject({
            agentName: 'build',
            providerId: 'anthropic',
            modelId: 'claude-sonnet-4-5',
        });
    });

    test('reads provider and model from the current nested user-message shape', () => {
        expect(readUserMessageHeaderIdentity({
            agent: 'build',
            model: {
                providerID: 'openai',
                modelID: 'gpt-5.6',
                variant: 'high',
            },
        })).toEqual({
            agentName: 'build',
            providerId: 'openai',
            modelId: 'gpt-5.6',
            variant: 'high',
        });
    });

    test('returns null when the user row has no header identity', () => {
        expect(readUserMessageHeaderIdentity({ role: 'user' })).toBeNull();
        expect(readUserMessageHeaderIdentity(null)).toBeNull();
    });
});

describe('resolveAssistantHeaderModel', () => {
    test('uses the composer pick while the assistant row has no model yet', () => {
        expect(resolveAssistantHeaderModel({
            assistantIdentity: null,
            userIdentity: null,
            sessionSelection: null,
            composerSelection: { providerId: 'openai', modelId: 'gpt-5.6' },
            allowComposerFallback: true,
        })).toEqual({ providerId: 'openai', modelId: 'gpt-5.6' });
    });

    test('keeps a stamped user row ahead of a later composer change', () => {
        expect(resolveAssistantHeaderModel({
            assistantIdentity: null,
            userIdentity: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
            sessionSelection: { providerId: 'openai', modelId: 'gpt-5.6' },
            composerSelection: { providerId: 'openai', modelId: 'gpt-5.6' },
            allowComposerFallback: true,
        })).toEqual({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5' });
    });

    test('prefers the live composer over older session memory while the turn is open', () => {
        expect(resolveAssistantHeaderModel({
            assistantIdentity: null,
            userIdentity: null,
            sessionSelection: { providerId: 'openai', modelId: 'gpt-4.1' },
            composerSelection: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
            allowComposerFallback: true,
        })).toEqual({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5' });
    });

    test('does not borrow the live composer for a settled assistant that omitted model', () => {
        expect(resolveAssistantHeaderModel({
            assistantIdentity: { agentName: 'build' },
            userIdentity: null,
            sessionSelection: null,
            composerSelection: { providerId: 'openai', modelId: 'gpt-5.6' },
            allowComposerFallback: false,
        })).toBeNull();
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
