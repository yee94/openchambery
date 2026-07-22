import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2';
import {
  ASSISTANT_SESSION_DIVIDER_PREFIX,
  createAssistantSessionDivider,
  isAssistantSessionDivider,
  stitchHostedSessionHistory,
  toChatMessageEntries,
} from './hostedSessionHistory';

const entry = (id: string) => ({ info: { id, role: 'user' as const, time: { created: 1 } } as Message, parts: [] });
const bare = (id: string) => ({ id, role: 'user' as const, time: { created: 1 } }) as Message;

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

  test('stitches prior sessions with dividers between segments only', () => {
    const read = (sessionID: string) => {
      if (sessionID === 'ses_a') return [entry('a1'), entry('a2')];
      if (sessionID === 'ses_b') return [entry('b1')];
      return [];
    };
    const stitched = stitchHostedSessionHistory(['ses_a', 'ses_b', 'ses_live'], 'ses_live', '/workspace', read);
    expect(stitched.map((item) => item.info.id)).toEqual([
      'a1',
      'a2',
      `${ASSISTANT_SESSION_DIVIDER_PREFIX}ses_b`,
      'b1',
    ]);
  });

  test('reuses an unchanged stitched prefix containing session dividers', () => {
    const entriesBySession = {
      ses_a: [entry('a1')],
      ses_b: [entry('b1')],
    };
    const read = (sessionID: string) => entriesBySession[sessionID as keyof typeof entriesBySession] ?? [];
    const first = stitchHostedSessionHistory(['ses_a', 'ses_b'], 'ses_live', '/workspace', read);
    const second = stitchHostedSessionHistory(['ses_a', 'ses_b'], 'ses_live', '/workspace', read, first);

    expect(second).toBe(first);
  });

  test('skips empty and current sessions', () => {
    const read = (sessionID: string) => (sessionID === 'ses_a' ? [entry('a1')] : []);
    expect(stitchHostedSessionHistory(['ses_empty', 'ses_a', 'ses_live'], 'ses_live', '/workspace', read).map((item) => item.info.id)).toEqual(['a1']);
    expect(stitchHostedSessionHistory([], 'ses_live', '/workspace', read)).toEqual([]);
  });
});
