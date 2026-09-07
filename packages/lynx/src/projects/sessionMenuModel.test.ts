import { describe, expect, test, vi } from 'vitest';

import {
  buildLynxProjectMenuItems,
  buildLynxSessionMenuItems,
  buildLynxWorktreeMenuItems,
} from './sessionMenuModel';

describe('buildLynxSessionMenuItems', () => {
  test('matches Cap order: pin/archive/delete; callbacks gate visibility', () => {
    const items = buildLynxSessionMenuItems({
      pinned: true,
      shared: false,
      onTogglePin: vi.fn(),
      onShare: vi.fn(),
      onArchive: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(items.map((item) => item.id)).toEqual(['pin', 'share', 'archive', 'delete']);
    expect(items.find((item) => item.id === 'pin')?.labelKey).toBe('lynx.projects.menu.unpin');
    expect(items.find((item) => item.id === 'delete')?.destructive).toBe(true);
  });

  test('shared sessions expose copy/unshare instead of share', () => {
    const items = buildLynxSessionMenuItems({
      pinned: false,
      shared: true,
      onCopyLink: vi.fn(),
      onUnshare: vi.fn(),
      onArchive: vi.fn(),
    });
    expect(items.map((item) => item.id)).toEqual(['copyLink', 'unshare', 'archive']);
  });
});

describe('buildLynxProjectMenuItems', () => {
  test('includes newWorktree only for git repositories', () => {
    const withGit = buildLynxProjectMenuItems({
      gitRepository: true,
      onNewSession: vi.fn(),
      onNewWorktree: vi.fn(),
      onSyncSessions: vi.fn(),
      onEditProject: vi.fn(),
      onCloseProject: vi.fn(),
    });
    const withoutGit = buildLynxProjectMenuItems({
      gitRepository: false,
      onNewSession: vi.fn(),
      onNewWorktree: vi.fn(),
      onSyncSessions: vi.fn(),
      onEditProject: vi.fn(),
      onCloseProject: vi.fn(),
    });
    expect(withGit.map((item) => item.id)).toEqual([
      'newSession',
      'newWorktree',
      'syncSessions',
      'edit',
      'closeProject',
    ]);
    expect(withoutGit.map((item) => item.id)).toEqual([
      'newSession',
      'syncSessions',
      'edit',
      'closeProject',
    ]);
  });
});

describe('buildLynxWorktreeMenuItems', () => {
  test('exposes newSession + destructive deleteWorktree', () => {
    const items = buildLynxWorktreeMenuItems({
      onNewSession: vi.fn(),
      onDeleteWorktree: vi.fn(),
    });
    expect(items.map((item) => item.id)).toEqual(['newSession', 'deleteWorktree']);
    expect(items.find((item) => item.id === 'deleteWorktree')?.destructive).toBe(true);
  });
});
