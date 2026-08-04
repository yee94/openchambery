import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';
import { normalizeUserDisplayParts } from './normalizeUserDisplayParts';

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
});
