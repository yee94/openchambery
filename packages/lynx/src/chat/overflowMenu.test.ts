import { describe, expect, test } from 'vitest';

import {
  LYNX_CHAT_OVERFLOW_ITEMS,
  chatSheetFromOverflowId,
} from './overflowMenu';

describe('Lynx chat overflow menu', () => {
  test('Cap phone order: new-session first, then Files/Changes/MCP/refresh', () => {
    const ids = LYNX_CHAT_OVERFLOW_ITEMS.map((item) => item.id);
    expect(ids[0]).toBe('newSession');
    expect(ids).toEqual([
      'newSession',
      'files',
      'changes',
      'mcp',
      'refreshTranscript',
    ]);
    expect(LYNX_CHAT_OVERFLOW_ITEMS.find((i) => i.id === 'files')?.stubSheet).toBeUndefined();
    expect(LYNX_CHAT_OVERFLOW_ITEMS.find((i) => i.id === 'changes')?.stubSheet).toBeUndefined();
    expect(LYNX_CHAT_OVERFLOW_ITEMS.find((i) => i.id === 'mcp')?.stubSheet).toBeUndefined();
  });

  test('maps overflow ids to sheet kinds without inventing routes', () => {
    expect(chatSheetFromOverflowId('files')).toBe('files');
    expect(chatSheetFromOverflowId('changes')).toBe('changes');
    expect(chatSheetFromOverflowId('mcp')).toBe('mcp');
    expect(chatSheetFromOverflowId('refreshTranscript')).toBeNull();
    expect(chatSheetFromOverflowId('newSession')).toBeNull();
  });
});
