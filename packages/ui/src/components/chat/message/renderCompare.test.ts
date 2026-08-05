import { describe, expect, test } from 'bun:test';
import type { TurnGroupingContext } from '../lib/turns/types';
import { areRelevantTurnGroupingContextsEqual } from './renderCompare';

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
});
