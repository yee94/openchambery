import { describe, expect, test } from 'vitest';

import {
  LYNX_CHAT_OVERFLOW_ITEMS,
  chatSheetFromOverflowId,
  dirtyChangeBadgeFromGitStatus,
  withOverflowDirtyBadge,
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

  test('Changes dirty badge from git status entry count (no fake on failure)', () => {
    expect(dirtyChangeBadgeFromGitStatus(null)).toBeNull();
    expect(dirtyChangeBadgeFromGitStatus({ status: 'no-runtime' })).toBeNull();
    expect(dirtyChangeBadgeFromGitStatus({ status: 'no-directory' })).toBeNull();
    expect(dirtyChangeBadgeFromGitStatus({
      status: 'failed',
      error: new Error('boom'),
    })).toBeNull();
    expect(dirtyChangeBadgeFromGitStatus({
      status: 'ok',
      directory: '/tmp/p',
      branch: 'main',
      entries: [],
      diffStats: {},
      ahead: 0,
      behind: 0,
      tracking: null,
    })).toBe(0);
    expect(dirtyChangeBadgeFromGitStatus({
      status: 'ok',
      directory: '/tmp/p',
      branch: 'main',
      entries: [
        { path: 'a.ts', status: 'M', staged: false },
        { path: 'b.ts', status: 'A', staged: true },
      ],
      diffStats: {},
      ahead: 0,
      behind: 0,
      tracking: null,
    })).toBe(2);

    const withBadge = withOverflowDirtyBadge(LYNX_CHAT_OVERFLOW_ITEMS, 3);
    expect(withBadge.find((i) => i.id === 'changes')?.badge).toBe(3);
    const noFake = withOverflowDirtyBadge(LYNX_CHAT_OVERFLOW_ITEMS, null);
    expect(noFake.find((i) => i.id === 'changes')?.badge).toBeNull();
    expect(noFake.find((i) => i.id === 'files')?.badge).toBeUndefined();
  });
});
