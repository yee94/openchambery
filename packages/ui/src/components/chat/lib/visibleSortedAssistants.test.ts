import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { ChatMessageEntry } from './turns/types';
import { isAssistantMessageCompleted, resolveVisibleSortedAssistants } from './visibleSortedAssistants';

const assistant = (id: string, completed?: number): ChatMessageEntry => ({
  info: {
    id,
    role: 'assistant',
    sessionID: 'ses_1',
    time: completed !== undefined ? { created: 1, completed } : { created: 1 },
  } as Message,
  parts: [] as Part[],
});

describe('resolveVisibleSortedAssistants', () => {
  test('keeps earlier incomplete assistants while a later sibling is streaming', () => {
    const a1 = assistant('a1'); // tools already ran; completion metadata lagging
    const a2 = assistant('a2'); // currently streaming
    const visible = resolveVisibleSortedAssistants([a1, a2], 'a2');
    expect(visible.map((entry) => entry.info.id)).toEqual(['a1', 'a2']);
  });

  test('shows the full turn once every assistant is completed', () => {
    const a1 = assistant('a1', 10);
    const a2 = assistant('a2', 20);
    expect(resolveVisibleSortedAssistants([a1, a2], null).map((entry) => entry.info.id)).toEqual([
      'a1',
      'a2',
    ]);
  });

  test('keeps incomplete assistants when stream id is unknown mid-turn', () => {
    // Between shell steps stream id / session_status often clear for a frame.
    // completed-only filtering dropped a2 and its Activity tools → fold flash.
    const a1 = assistant('a1', 10);
    const a2 = assistant('a2');
    expect(resolveVisibleSortedAssistants([a1, a2], null).map((entry) => entry.info.id)).toEqual([
      'a1',
      'a2',
    ]);
  });

  test('keeps the full turn when nothing is completed yet and no stream id', () => {
    const a1 = assistant('a1');
    const a2 = assistant('a2');
    expect(resolveVisibleSortedAssistants([a1, a2], null).map((entry) => entry.info.id)).toEqual([
      'a1',
      'a2',
    ]);
  });
});

describe('isAssistantMessageCompleted', () => {
  test('requires positive completed time', () => {
    expect(isAssistantMessageCompleted(assistant('a1'))).toBe(false);
    expect(isAssistantMessageCompleted(assistant('a1', 0))).toBe(false);
    expect(isAssistantMessageCompleted(assistant('a1', 5))).toBe(true);
  });
});
