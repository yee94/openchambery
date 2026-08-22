import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';
import { hasUserDisplayableParts, normalizeUserDisplayParts } from './normalizeUserDisplayParts';

describe('normalizeUserDisplayParts', () => {
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
