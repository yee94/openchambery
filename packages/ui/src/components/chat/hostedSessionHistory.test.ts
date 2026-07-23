import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2';
import type { AssistantHistoryEntry } from '@/queries/assistantQueries';
import {
  ASSISTANT_SESSION_DIVIDER_PREFIX,
  createAssistantSessionDivider,
  flattenAssistantHistoryPages,
  isAssistantSessionDivider,
  stitchHostedSessionHistory,
  toChatMessageEntries,
} from './hostedSessionHistory';

const entry = (id: string) => ({ info: { id, role: 'user' as const, time: { created: 1 } } as Message, parts: [] });
const bare = (id: string) => ({ id, role: 'user' as const, time: { created: 1 } }) as Message;
const historyEntry = (sessionID: string, id: string, directory: string | null = '/workspace'): AssistantHistoryEntry => ({ sessionID, directory, info: { ...bare(id), sessionID }, parts: [] });

describe('hostedSessionHistory', () => {
  test('detects synthetic session dividers', () => {
    const divider = createAssistantSessionDivider('ses_2', 10);
    expect(isAssistantSessionDivider(divider)).toBe(true);
    expect(divider.info.id.startsWith(ASSISTANT_SESSION_DIVIDER_PREFIX)).toBe(true);
    expect(isAssistantSessionDivider(entry('msg_1'))).toBe(false);
  });

  test('maps bare sync Message[] into ChatMessageEntry records', () => {
    const mapped = toChatMessageEntries([bare('a1'), bare('a2')], { a1: [{ type: 'text', text: 'hi' } as never] });
    expect(mapped).toHaveLength(2);
    expect(mapped[0]?.info.id).toBe('a1');
    expect(mapped[0]?.parts).toEqual([{ type: 'text', text: 'hi' }]);
    expect(mapped[1]?.parts).toEqual([]);
  });

  test('stitches server history entries with dividers between sessions only', () => {
    const stitched = stitchHostedSessionHistory([
      historyEntry('ses_a', 'a1'),
      historyEntry('ses_a', 'a2'),
      historyEntry('ses_b', 'b1'),
      historyEntry('ses_live', 'live'),
    ], 'ses_live');
    expect(stitched.map((item) => item.info.id)).toEqual([
      'a1',
      'a2',
      `${ASSISTANT_SESSION_DIVIDER_PREFIX}ses_b`,
      'b1',
    ]);
  });

  test('keeps three history pages in oldest-to-newest order and divides page-boundary sessions', () => {
    const newestPage = [historyEntry('ses_c', 'c1')];
    const middlePage = [historyEntry('ses_b', 'b1')];
    const oldestPage = [historyEntry('ses_a', 'a1')];
    const entries = [newestPage, middlePage, oldestPage].slice().reverse().flat();

    expect(stitchHostedSessionHistory(entries, 'ses_live').map((item) => item.info.id)).toEqual([
      'a1',
      `${ASSISTANT_SESSION_DIVIDER_PREFIX}ses_b`,
      'b1',
      `${ASSISTANT_SESSION_DIVIDER_PREFIX}ses_c`,
      'c1',
    ]);
  });

  test('keeps chronological order through small and empty cursor pages', () => {
    const pages = [
      { entries: [historyEntry('ses_c', 'c1')], nextCursor: 'cursor_b', complete: false },
      { entries: [], nextCursor: 'cursor_a', complete: false },
      { entries: [historyEntry('ses_b', 'b1'), historyEntry('ses_b', 'b2')], nextCursor: 'cursor_0', complete: false },
      { entries: [historyEntry('ses_a', 'a1')], nextCursor: null, complete: true },
    ];

    expect(flattenAssistantHistoryPages(pages).map((item) => item.info.id)).toEqual(['a1', 'b1', 'b2', 'c1']);
    expect(stitchHostedSessionHistory(flattenAssistantHistoryPages(pages), 'ses_live').map((item) => item.info.id)).toEqual([
      'a1',
      `${ASSISTANT_SESSION_DIVIDER_PREFIX}ses_b`,
      'b1',
      'b2',
      `${ASSISTANT_SESSION_DIVIDER_PREFIX}ses_c`,
      'c1',
    ]);
  });

  test('reuses an unchanged stitched prefix containing session dividers', () => {
    const entries = [historyEntry('ses_a', 'a1'), historyEntry('ses_b', 'b1')];
    const first = stitchHostedSessionHistory(entries, 'ses_live');
    const second = stitchHostedSessionHistory(entries, 'ses_live', first);

    expect(second).toBe(first);
  });

  test('keeps original entry references and skips the current session', () => {
    const source = historyEntry('ses_a', 'a1', '/workspace-a');
    const current = historyEntry('ses_live', 'live', '/workspace-live');
    expect(stitchHostedSessionHistory([source, current], 'ses_live').map((item) => item.info.id)).toEqual(['a1']);
    expect(stitchHostedSessionHistory([source], 'ses_live')[0]?.info).toBe(source.info);
    expect(stitchHostedSessionHistory([source], 'ses_live')[0]?.parts).toBe(source.parts);
    expect(stitchHostedSessionHistory([], 'ses_live')).toEqual([]);
  });

  test('preserves an unknown historical directory for its read-only message context', () => {
    const source = historyEntry('ses_a', 'a1', null);

    expect(stitchHostedSessionHistory([source], 'ses_live')[0]?.sourceSessionID).toBe('ses_a');
    expect(stitchHostedSessionHistory([source], 'ses_live')[0]?.sourceDirectory).toBeNull();
  });
});
