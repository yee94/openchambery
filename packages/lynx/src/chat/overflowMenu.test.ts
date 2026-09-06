import { describe, expect, test } from 'vitest';

import {
  LYNX_CHAT_OVERFLOW_ITEMS,
  chatSheetFromOverflowId,
} from './overflowMenu';

describe('Lynx chat overflow menu', () => {
  test('exposes Files and Changes as labeled stub sheet entry points', () => {
    const ids = LYNX_CHAT_OVERFLOW_ITEMS.map((item) => item.id);
    expect(ids).toContain('files');
    expect(ids).toContain('changes');
    expect(LYNX_CHAT_OVERFLOW_ITEMS.find((i) => i.id === 'files')?.stubSheet).toBe(true);
    expect(LYNX_CHAT_OVERFLOW_ITEMS.find((i) => i.id === 'changes')?.stubSheet).toBe(true);
  });

  test('maps overflow ids to sheet kinds without inventing routes', () => {
    expect(chatSheetFromOverflowId('files')).toBe('files');
    expect(chatSheetFromOverflowId('changes')).toBe('changes');
    expect(chatSheetFromOverflowId('refreshTranscript')).toBeNull();
  });
});
