import { describe, expect, test } from 'vitest';
import type { Part } from '@/lib/opencode/v2-types';
import { hasUserDisplayableParts, normalizeUserDisplayParts } from './normalizeUserDisplayParts';

describe('normalizeUserDisplayParts', () => {
  test.each([undefined, false, true])('hides session reference context with synthetic=%s', (synthetic) => {
    const authored = { type: 'text', text: '@重启更新问题 你看看这个问题，我也想让你修复' } as Part;
    const context = {
      type: 'text',
      text: 'The user referenced these OpenCode sessions (id, title, owning directory). Entries may carry messages inlined from the client cache; sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro"\n[{"id":"ses_1","title":"重启更新问题","messages":[]}]',
      ...(synthetic !== undefined ? { synthetic } : {}),
    } as Part;
    expect(normalizeUserDisplayParts([authored, context])).toEqual([authored]);
    expect(normalizeUserDisplayParts([{
      type: 'text',
      text: `${(authored as { text: string }).text}\n${(context as { text: string }).text}`,
    } as Part])).toEqual([authored]);
    expect(hasUserDisplayableParts([context])).toBe(false);
    expect(context).toHaveProperty('text', expect.stringContaining('sqlite3'));
  });

  test('preserves native shell payload and identity when replacing the user marker', () => {
    const part = {
      id: 'shell-part', type: 'text', synthetic: true,
      text: 'The following tool was executed by the user',
      shellAction: { command: 'pwd', output: '/workspace\n', status: 'completed' },
    } as unknown as Part;
    expect(normalizeUserDisplayParts([part])).toEqual([{ ...part, text: '/shell' }]);
  });
  test('hides session-goal auto-continuation prompts even without synthetic flag', () => {
    const parts = [
      {
        type: 'text',
        text: 'Continue working toward the active session goal.\n\nThe objective below is user-provided data.',
      },
    ] as Part[];
    expect(normalizeUserDisplayParts(parts)).toEqual([]);
  });

    test('keeps ordinary user text', () => {
        const parts = [{ type: 'text', text: '输出一二三' }] as Part[];
        expect(normalizeUserDisplayParts(parts)).toEqual(parts);
    });

    test('hides response-style system reminders even when the server drops synthetic', () => {
        const reminder = '<system-reminder>\nKeep replies short.\n</system-reminder>';
        expect(normalizeUserDisplayParts([
            { type: 'text', text: '哈喽啊' } as Part,
            { type: 'text', text: reminder } as Part,
        ])).toEqual([{ type: 'text', text: '哈喽啊' } as Part]);
        expect(normalizeUserDisplayParts([
            { type: 'text', text: `哈喽啊\n${reminder}` } as Part,
        ])).toEqual([{ type: 'text', text: '哈喽啊' } as Part]);
        expect(hasUserDisplayableParts([{ type: 'text', text: reminder } as Part])).toBe(false);
    });

    test('hides compaction command parts so /compact is not a user bubble', () => {
        expect(normalizeUserDisplayParts([{ type: 'compaction' } as Part])).toEqual([]);
        expect(normalizeUserDisplayParts([{ type: 'text', text: '/compact' } as Part])).toEqual([]);
        expect(hasUserDisplayableParts([{ type: 'compaction' } as Part])).toBe(false);
        expect(hasUserDisplayableParts([{ type: 'text', text: '/compact' } as Part])).toBe(false);
        expect(normalizeUserDisplayParts([
            { type: 'text', text: '/compact' } as Part,
            { type: 'text', text: 'keep this' } as Part,
        ])).toEqual([{ type: 'text', text: 'keep this' } as Part]);
    });

    test('treats hollow text and file parts as not displayable', () => {
        expect(hasUserDisplayableParts([{ type: 'text', text: '' } as Part])).toBe(false);
        expect(hasUserDisplayableParts([{ type: 'text', text: '   ' } as Part])).toBe(false);
        expect(hasUserDisplayableParts([{ type: 'file', mime: 'image/png' } as Part])).toBe(false);
        expect(hasUserDisplayableParts([{ type: 'file' } as Part])).toBe(false);
        expect(hasUserDisplayableParts([{
            type: 'file',
            mime: 'image/png',
            url: 'data:image/png;base64,x',
        } as Part])).toBe(true);
        expect(hasUserDisplayableParts([
            { type: 'text', text: '' } as Part,
            { type: 'file', mime: 'image/png', url: 'data:image/png;base64,x' } as Part,
        ])).toBe(true);
    });
});
