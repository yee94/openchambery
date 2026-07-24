import { describe, expect, test } from 'bun:test';
import { mergePendingUserMessagePresentations, resolveChatContainerHostFeatures, type ChatContainerHost } from './chatContainerHost';
import type { PendingUserMessagePresentation } from '@/sync/session-ui-store';

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
  test('keeps a pending row until its stable message ID is authoritative', () => {
    const pending = {
      info: { id: 'msg_pending', role: 'user' },
      parts: [{ type: 'text', text: 'hello' }],
    } as PendingUserMessagePresentation;
    const first = mergePendingUserMessagePresentations([], [pending]);
    expect(first).toEqual([pending]);

    const authoritative = [{
      info: { ...pending.info, sessionID: 'ses_real' },
      parts: [{ type: 'text', text: 'hello from server' }],
    }] as PendingUserMessagePresentation[];
    const reconciled = mergePendingUserMessagePresentations(authoritative, [pending]);
    expect(reconciled).toBe(authoritative);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.parts[0]).toEqual({ type: 'text', text: 'hello from server' });
  });

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
