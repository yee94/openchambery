import { describe, expect, test } from 'bun:test';
import { resolveChatContainerHostFeatures, type ChatContainerHost } from './chatContainerHost';

const sampleHost = (features?: ChatContainerHost['features']): ChatContainerHost => ({
  sessionId: 'ses_test',
  directory: '/workspace',
  composerSurface: { kind: 'secondary', surfaceID: 'assistant:test' } as ChatContainerHost['composerSurface'],
  sessionSurface: {
    kind: 'embedded',
    surfaceId: 'assistant:test',
    sessionId: 'ses_test',
    directory: '/workspace',
    active: true,
    capabilities: {
      compose: true,
      mutateSession: true,
      answerRequests: true,
      openTimeline: true,
      navigateNestedSession: false,
      textSelectionActions: true,
      forkSession: false,
    },
  },
  features,
});

describe('chatContainerHost', () => {
  test('keeps primary-only features on when no host is provided', () => {
    expect(resolveChatContainerHostFeatures(undefined)).toEqual({
      newSessionDraft: true,
      promptNavigator: true,
      returnToParent: true,
    });
  });

  test('disables primary-only features for hosted surfaces by default', () => {
    expect(resolveChatContainerHostFeatures(sampleHost())).toEqual({
      newSessionDraft: false,
      promptNavigator: false,
      returnToParent: false,
    });
  });

  test('allows hosted surfaces to re-enable selected primary features', () => {
    expect(resolveChatContainerHostFeatures(sampleHost({ promptNavigator: true }))).toEqual({
      newSessionDraft: false,
      promptNavigator: true,
      returnToParent: false,
    });
  });
});
