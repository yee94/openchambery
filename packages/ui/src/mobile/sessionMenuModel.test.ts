import { describe, expect, test } from 'vitest';

import {
  buildProjectMenuItems,
  buildSessionMenuItems,
  buildWorktreeMenuItems,
} from './sessionMenuModel';

describe('buildSessionMenuItems', () => {
  test('orders the full shared session set and gates on callbacks', () => {
    const items = buildSessionMenuItems({
      pinned: true,
      shared: true,
      onRename: () => undefined,
      onTogglePin: () => undefined,
      onCopyLink: () => undefined,
      onUnshare: () => undefined,
      onRefreshTranscript: () => undefined,
      onArchive: () => undefined,
      onDelete: () => undefined,
    });

    expect(items.map((item) => item.id)).toEqual([
      'rename',
      'pin',
      'copyLink',
      'unshare',
      'refreshTranscript',
      'archive',
      'delete',
    ]);
    expect(items.find((item) => item.id === 'pin')?.labelKey).toBe('sessions.sidebar.session.menu.unpin');
    expect(items.find((item) => item.id === 'delete')?.separated).toBe(true);
  });

  test('shows share instead of copy/unshare when not shared', () => {
    const items = buildSessionMenuItems({
      pinned: false,
      shared: false,
      onShare: () => undefined,
      onCopyLink: () => undefined,
      onUnshare: () => undefined,
    });

    expect(items.map((item) => item.id)).toEqual(['share']);
  });

  test('appends extraItems without shrinking the shared set', () => {
    const items = buildSessionMenuItems({
      pinned: false,
      shared: false,
      onArchive: () => undefined,
      extraItems: [{
        id: 'exportMarkdown',
        icon: 'file-copy',
        labelKey: 'sessions.sidebar.bulkActions.archive',
        onClick: () => undefined,
      }],
    });

    expect(items.map((item) => item.id)).toEqual(['archive', 'exportMarkdown']);
  });
});

describe('buildProjectMenuItems', () => {
  test('includes newWorktree only for git repositories', () => {
    const withGit = buildProjectMenuItems({
      gitRepository: true,
      onNewSession: () => undefined,
      onNewWorktree: () => undefined,
      onSyncSessions: () => undefined,
      onEditProject: () => undefined,
      onCloseProject: () => undefined,
    });
    const withoutGit = buildProjectMenuItems({
      gitRepository: false,
      onNewSession: () => undefined,
      onNewWorktree: () => undefined,
      onSyncSessions: () => undefined,
      onEditProject: () => undefined,
      onCloseProject: () => undefined,
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

describe('buildWorktreeMenuItems', () => {
  test('orders newSession then separated deleteWorktree', () => {
    const items = buildWorktreeMenuItems({
      onNewSession: () => undefined,
      onDeleteWorktree: () => undefined,
    });

    expect(items.map((item) => item.id)).toEqual(['newSession', 'deleteWorktree']);
    expect(items[1]?.separated).toBe(true);
    expect(items[1]?.destructive).toBe(true);
  });
});
