import { describe, expect, test } from 'vitest';

import {
  extractLynxContactCards,
  filterLynxContactDisplayParts,
  hasLynxUserDisplayableParts,
  projectLynxContactTimelineEntries,
} from './contactDisplay';
import {
  buildLynxContactTranscript,
  createLynxAssistantSessionDivider,
  isLynxAssistantSessionDivider,
  mergeLynxCurrentSessionHistory,
  stitchLynxAssistantHistory,
} from './contactMerge';
import type { LynxAssistantHistoryEntry } from './contactMessages';

const historyEntry = (
  sessionID: string,
  id: string,
  role: 'user' | 'assistant' = 'user',
  text = 'hello',
): LynxAssistantHistoryEntry => ({
  sessionID,
  directory: '/work',
  info: {
    id,
    sessionID,
    role,
    time: { created: 1 },
  },
  parts: [{
    id: `${id}_p`,
    sessionID,
    messageID: id,
    type: 'text',
    text,
  }],
});

describe('contact display settle filter', () => {
  test('filters Cap settle / goal / compact / synthetic shells', () => {
    const filtered = filterLynxContactDisplayParts([
      { type: 'text', text: 'Continue working toward the active session goal.' },
      { type: 'text', text: '/compact' },
      { type: 'text', text: '<system-reminder>hidden</system-reminder>', synthetic: true },
      { type: 'text', text: 'visible user' },
      { type: 'text', text: 'The following tool was executed by the user', synthetic: true },
      { type: 'compaction' },
    ]);
    expect(filtered.map((part) => part.text)).toEqual(['visible user', '/shell']);
  });

  test('hollow synthetic-only parts are not displayable', () => {
    expect(hasLynxUserDisplayableParts([
      { type: 'text', text: '<system-reminder>x</system-reminder>', synthetic: true },
    ])).toBe(false);
    expect(hasLynxUserDisplayableParts([
      { type: 'text', text: 'hi' },
    ])).toBe(true);
  });
});

describe('contact cards', () => {
  test('labels file parts and mention cards', () => {
    const cards = extractLynxContactCards({
      info: { id: 'msg_1', role: 'user' },
      parts: [
        { type: 'text', text: 'See @session:ses_9 and @assistant:asst_2 @schedule:task_1' },
        { type: 'file', id: 'f1', mime: 'image/png', filename: 'shot.png', url: 'https://x/a.png' },
      ],
    });
    expect(cards.some((card) => card.kind === 'session' && card.targetId === 'ses_9')).toBe(true);
    expect(cards.some((card) => card.kind === 'assistant' && card.targetId === 'asst_2')).toBe(true);
    expect(cards.some((card) => card.kind === 'schedule' && card.targetId === 'task_1')).toBe(true);
    expect(cards.some((card) => card.kind === 'file' && card.label === 'shot.png')).toBe(true);
  });
});

describe('contact merge / stitch', () => {
  test('session dividers are detected', () => {
    const divider = createLynxAssistantSessionDivider('ses_2', 10);
    expect(isLynxAssistantSessionDivider(divider)).toBe(true);
  });

  test('stitches archived sessions and skips current binding', () => {
    const stitched = stitchLynxAssistantHistory([
      historyEntry('ses_a', 'a1'),
      historyEntry('ses_b', 'b1'),
      historyEntry('ses_live', 'live'),
    ], 'ses_live');
    expect(stitched.map((item) => item.info.id)).toEqual([
      'a1',
      'oc_asst_session_divider:ses_b',
      'b1',
    ]);
  });

  test('merge prefers displayable history over hollow live', () => {
    const merged = mergeLynxCurrentSessionHistory(
      [historyEntry('ses_live', 'msg_1', 'user', 'admitted')],
      'ses_live',
      [{
        info: { id: 'msg_1', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', text: '<system-reminder>x</system-reminder>', synthetic: true }],
        kind: 'message',
      }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.parts[0]).toMatchObject({ text: 'admitted' });
  });

  test('buildLynxContactTranscript projects timeline entries', () => {
    const transcript = buildLynxContactTranscript([
      historyEntry('ses_a', 'a1'),
      historyEntry('ses_live', 'live1'),
    ], 'ses_live');
    const entries = projectLynxContactTimelineEntries(transcript);
    expect(entries.some((entry) => entry.messageId === 'a1')).toBe(true);
    expect(entries.some((entry) => entry.messageId === 'live1')).toBe(true);
    expect(entries.some((entry) => entry.messageId.startsWith('oc_asst_session_divider:'))).toBe(true);
  });
});
