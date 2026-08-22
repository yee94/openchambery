import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2';
import type { TurnGroupingContext } from '../lib/turns/types';
import { areRenderRelevantMessagesEqual, areRelevantTurnGroupingContextsEqual } from './renderCompare';

const toggleGroup = () => {};

const createContext = (overrides: Partial<TurnGroupingContext> = {}): TurnGroupingContext => ({
  turnId: 'turn-1',
  isFirstAssistantInTurn: false,
  isLastAssistantInTurn: false,
  isLatestTurn: false,
  hasTools: true,
  hasReasoning: true,
  isWorking: false,
  isTurnSettled: false,
  isGroupExpanded: false,
  toggleGroup,
  ...overrides,
});

const expectExpansionChange = (
  context: TurnGroupingContext,
  messageId: string,
  isUserMessage = false,
) => {
  expect(areRelevantTurnGroupingContextsEqual(
    context,
    { ...context, isGroupExpanded: true },
    messageId,
    isUserMessage,
  )).toBe(isUserMessage);
};

describe('areRelevantTurnGroupingContextsEqual', () => {
  test('treats expansion as a direct dependency for the activity owner', () => {
    expectExpansionChange(createContext({ activityOwnerMessageId: 'assistant-owner' }), 'assistant-owner');
  });

  test('treats expansion as a direct dependency for an activity segment anchor', () => {
    expectExpansionChange(createContext({
      activityGroupSegments: [{
        id: 'segment-1',
        anchorMessageId: 'assistant-anchor',
        afterToolPartId: null,
        parts: [],
      }],
    }), 'assistant-anchor');
  });

  test('treats expansion as a direct dependency for an ordinary assistant message', () => {
    expectExpansionChange(createContext(), 'assistant-ordinary');
  });

  test('ignores turn context expansion for a user message', () => {
    expectExpansionChange(createContext({ activityOwnerMessageId: 'assistant-owner' }), 'user-1', true);
  });

  test('treats a count-only changes marker as relevant to the last assistant', () => {
    const before = createContext({
      isLastAssistantInTurn: true,
      diffStats: { additions: 0, deletions: 0, files: 0, hasDiffs: false },
    });
    const after = {
      ...before,
      diffStats: { additions: 0, deletions: 0, files: 463, hasDiffs: true },
    };
    expect(areRelevantTurnGroupingContextsEqual(before, after, 'assistant-last', false)).toBe(false);
  });
});

describe('areRenderRelevantMessagesEqual — token counts', () => {
  const baseMessage = {
    id: 'msg_a',
    role: 'assistant',
    sessionID: 'ses_1',
    finish: 'stop',
    time: { created: 1, completed: 2 },
  } as unknown as Message;

  test('tokens-only update re-renders (assistant TPS depends on it)', () => {
    const before = { ...baseMessage, tokens: { input: 10, output: 0, reasoning: 0 } } as Message;
    const after = { ...baseMessage, tokens: { input: 10, output: 42, reasoning: 7 } } as Message;
    expect(areRenderRelevantMessagesEqual(
      { info: before, parts: [] },
      { info: after, parts: [] },
    )).toBe(false);
  });

  test('equal tokens keep the memo hit', () => {
    const before = { ...baseMessage, tokens: { input: 10, output: 42, reasoning: 7 } } as Message;
    const after = { ...baseMessage, tokens: { input: 10, output: 42, reasoning: 7 } } as Message;
    expect(areRenderRelevantMessagesEqual(
      { info: before, parts: [] },
      { info: after, parts: [] },
    )).toBe(true);
  });

  test('tokens appearing (undefined → counts) re-renders', () => {
    expect(areRenderRelevantMessagesEqual(
      { info: { ...baseMessage } as Message, parts: [] },
      { info: { ...baseMessage, tokens: { input: 1, output: 2, reasoning: 0 } } as Message, parts: [] },
    )).toBe(false);
  });
});
