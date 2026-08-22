import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2';
import type { AssistantHistoryEntry } from '@/queries/assistantQueries';
import {
  ASSISTANT_SESSION_DIVIDER_PREFIX,
  createAssistantSessionDivider,
  flattenAssistantHistoryPages,
  isAssistantSessionDivider,
  mergeHostedCurrentSessionHistory,
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

  test('keeps SQLite current-session admissions until live sync replaces the same identity', () => {
    const persisted = historyEntry('ses_live', 'msg_user');
    const persistedReply = historyEntry('ses_live', 'msg_reply');
    const liveReply = entry('msg_reply');

    const merged = mergeHostedCurrentSessionHistory([persisted, persistedReply], 'ses_live', [liveReply]);

    expect(merged.map((item) => item.info.id)).toEqual(['msg_user', 'msg_reply']);
    expect(merged[0]?.info).toBe(persisted.info);
    expect(merged[1]).toBe(liveReply);
    expect(mergeHostedCurrentSessionHistory([persisted, persistedReply], 'ses_live', [liveReply], merged)).toBe(merged);
  });

  test('does not let a part-less live row wipe SQLite admission parts for the same message ID', () => {
    const admissionParts = [{ type: 'text', text: '哈喽，大哥招呼' } as never];
    const persisted: AssistantHistoryEntry = {
      sessionID: 'ses_live',
      directory: '/workspace',
      info: { ...bare('msg_user'), sessionID: 'ses_live', time: { created: 20 } },
      parts: admissionParts,
    };
    const livePartless = {
      info: { ...bare('msg_user'), sessionID: 'ses_live', time: { created: 20 }, agent: 'build' },
      parts: [],
    };

    const merged = mergeHostedCurrentSessionHistory([persisted], 'ses_live', [livePartless]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.info).toBe(livePartless.info);
    expect(merged[0]?.parts).toEqual(admissionParts);
  });

  test('lets live parts replace SQLite provisional parts for the same message ID', () => {
    const persisted: AssistantHistoryEntry = {
      sessionID: 'ses_live',
      directory: '/workspace',
      info: { ...bare('msg_user'), sessionID: 'ses_live', time: { created: 20 } },
      parts: [{ type: 'text', text: 'provisional' } as never],
    };
    const liveWithParts = {
      info: { ...bare('msg_user'), sessionID: 'ses_live', time: { created: 20 } },
      parts: [{ type: 'text', text: 'authoritative' } as never],
    };

    const merged = mergeHostedCurrentSessionHistory([persisted], 'ses_live', [liveWithParts]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(liveWithParts);
  });

  test('unions assistant history tools with lagging live reasoning-only snapshots', () => {
    const toolPart = {
      id: 'prt_tool',
      type: 'tool',
      tool: 'read',
      state: { status: 'completed', time: { start: 1, end: 2 } },
    } as never;
    const historyReasoning = { id: 'prt_reason', type: 'reasoning', text: 'old' } as never;
    const liveReasoning = { id: 'prt_reason', type: 'reasoning', text: 'streaming…' } as never;
    const persisted: AssistantHistoryEntry = {
      sessionID: 'ses_live',
      directory: '/workspace',
      info: { id: 'msg_asst', role: 'assistant', sessionID: 'ses_live', time: { created: 20 } } as Message,
      parts: [historyReasoning, toolPart],
    };
    const livePartial = {
      info: { id: 'msg_asst', role: 'assistant', sessionID: 'ses_live', time: { created: 20 } } as Message,
      parts: [liveReasoning],
    };

    const merged = mergeHostedCurrentSessionHistory([persisted], 'ses_live', [livePartial]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.parts.map((part) => (part as { id?: string }).id)).toEqual([
      'prt_reason',
      'prt_tool',
    ]);
    expect((merged[0]?.parts[0] as { text?: string })?.text).toBe('streaming…');
  });

  test('does not let synthetic-only live shells wipe SQLite admission text', () => {
    const admissionParts = [{ type: 'text', text: '123123' } as never];
    const persisted: AssistantHistoryEntry = {
      sessionID: 'ses_live',
      directory: '/workspace',
      info: { ...bare('msg_user'), sessionID: 'ses_live', time: { created: 20 } },
      parts: admissionParts,
    };
    const liveSystemOnly = {
      info: { ...bare('msg_user'), sessionID: 'ses_live', time: { created: 20 }, agent: 'build' },
      parts: [{
        type: 'text',
        text: '<system-reminder>\nKeep replies short.',
        synthetic: true,
      } as never],
    };

    const merged = mergeHostedCurrentSessionHistory([persisted], 'ses_live', [liveSystemOnly]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.info).toBe(liveSystemOnly.info);
    expect(merged[0]?.parts).toEqual(admissionParts);
  });

  test('previous assistant reply survives stateless binding advance once history owns it', () => {
    const oldUser = historyEntry('ses_old', 'msg_old_user');
    const oldReply: AssistantHistoryEntry = {
      sessionID: 'ses_old',
      directory: '/workspace',
      info: { id: 'msg_old_reply', role: 'assistant', sessionID: 'ses_old', time: { created: 2 } } as Message,
      parts: [{ type: 'text', text: 'old reply' } as never],
    };
    const oldLive = [
      entry('msg_old_user'),
      { info: { id: 'msg_old_reply', role: 'assistant' as const, time: { created: 2 } } as Message, parts: oldReply.parts },
    ];
    expect(mergeHostedCurrentSessionHistory([oldUser, oldReply], 'ses_old', oldLive).map((item) => item.info.id))
      .toEqual(['msg_old_user', 'msg_old_reply']);

    const newUser = historyEntry('ses_new', 'msg_new_user');
    const entries = [oldUser, oldReply, newUser];
    const prefix = stitchHostedSessionHistory(entries, 'ses_new');
    const current = mergeHostedCurrentSessionHistory(entries, 'ses_new', [entry('msg_new_user')]);

    expect(prefix.map((item) => item.info.id)).toEqual([
      'msg_old_user',
      'msg_old_reply',
    ]);
    expect(current.map((item) => item.info.id)).toEqual(['msg_new_user']);
    expect([...prefix, createAssistantSessionDivider('ses_new'), ...current].map((item) => item.info.id)).toEqual([
      'msg_old_user',
      'msg_old_reply',
      `${ASSISTANT_SESSION_DIVIDER_PREFIX}ses_new`,
      'msg_new_user',
    ]);
  });
});
