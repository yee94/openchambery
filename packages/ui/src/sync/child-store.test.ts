import { describe, expect, test } from 'bun:test';

import { ChildStoreManager } from './child-store';
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from './types';

describe('ChildStoreManager.subscribeAllSelected', () => {
  test('ignores unrelated child-store updates', () => {
    const manager = new ChildStoreManager();
    const child = manager.ensureChild('/workspace', { bootstrap: false });
    let notifications = 0;
    const unsubscribe = manager.subscribeAllSelected((state) => state.session, () => {
      notifications += 1;
    });

    child.setState({ session_status: { session: { type: 'busy' } } });
    expect(notifications).toBe(0);

    child.setState({ session: [...child.getState().session] });
    expect(notifications).toBe(1);

    unsubscribe();
    manager.disposeAll();
  });

  test('notifies when the child-store registry changes', () => {
    const manager = new ChildStoreManager();
    let notifications = 0;
    const unsubscribe = manager.subscribeAllSelected((state) => state.session, () => {
      notifications += 1;
    });

    manager.ensureChild('/workspace', { bootstrap: false });
    expect(notifications).toBe(1);

    unsubscribe();
    manager.disposeAll();
  });
});

describe('ChildStoreManager production State (Ticket 09 batch 2)', () => {
  test('a fresh child store has catalog/status domains without transcript maps', () => {
    const manager = new ChildStoreManager();
    const child = manager.ensureChild('/workspace', { bootstrap: false });

    const state = child.getState();
    expect(state.session).toEqual([]);
    expect(state.session_status).toEqual({});
    // Production DirectoryStore no longer owns message/part/boundary.
    expect('message' in state).toBe(false);
    expect('session_history_boundary' in state).toBe(false);
    // Unknown boundary is repository-owned when no Query entry exists.
    expect(UNKNOWN_SESSION_HISTORY_BOUNDARY).toEqual({ kind: 'unknown', loadedTurns: 0 });

    manager.disposeAll();
  });

  test('disposing and recreating a directory resets catalog state', () => {
    const manager = new ChildStoreManager();
    const original = manager.ensureChild('/workspace', { bootstrap: false });
    original.setState({
      session_status: {
        ses_1: { type: 'busy' },
      },
    });

    expect(manager.disposeDirectory('/workspace')).toBe(true);
    const recreated = manager.ensureChild('/workspace', { bootstrap: false });
    expect(recreated.getState().session_status).toEqual({});

    manager.disposeAll();
  });
});

describe('ChildStoreManager captures', () => {
  test('invalidates captures after dispose and recreation', () => {
    const manager = new ChildStoreManager();
    const original = manager.captureChild('/workspace', { bootstrap: false });
    expect(manager.isCurrentChildCapture(original)).toBe(true);

    expect(manager.disposeDirectory('/workspace')).toBe(true);
    expect(manager.isCurrentChildCapture(original)).toBe(false);

    const replacement = manager.captureChild('/workspace', { bootstrap: false });
    expect(replacement.generation).toBeGreaterThan(original.generation);
    expect(manager.isCurrentChildCapture(replacement)).toBe(true);
    manager.disposeAll();
  });

  test('invalidates every capture after disposeAll', () => {
    const manager = new ChildStoreManager();
    const first = manager.captureChild('/first', { bootstrap: false });
    const second = manager.captureChild('/second', { bootstrap: false });
    manager.disposeAll();

    expect(manager.isCurrentChildCapture(first)).toBe(false);
    expect(manager.isCurrentChildCapture(second)).toBe(false);
  });
});

// Directory strings reach this class from the session record, worktree
// metadata, window config and the directory picker. On Windows those disagree
// on separators and drive-letter case; with exact string keys a second store
// would be minted, take an HTTP status snapshot, and then never see another
// live event.
describe('ChildStoreManager Windows path spellings', () => {
  const spellings = [
    'c:\\Users\\me\\project',
    'C:\\Users\\me\\project',
    'C:/Users/me/project',
    'C:/Users/me/project/',
  ];

  test('every spelling of one directory resolves to the same store', () => {
    const manager = new ChildStoreManager();
    const canonical = manager.ensureChild(spellings[0], { bootstrap: false });

    for (const spelling of spellings) {
      expect(manager.ensureChild(spelling, { bootstrap: false })).toBe(canonical);
      expect(manager.getChild(spelling)).toBe(canonical);
    }

    expect(manager.children.size).toBe(1);
    manager.disposeAll();
  });

  test('an idle status written under one spelling is visible under another', () => {
    const manager = new ChildStoreManager();
    manager.ensureChild('C:/Users/me/project', { bootstrap: false });

    // The composer reads through the raw session-record spelling.
    manager.update('c:\\Users\\me\\project', (state) => ({
      session_status: { ...state.session_status, ses_1: { type: 'busy' } },
    }));
    expect(manager.getState('C:/Users/me/project')?.session_status.ses_1)
      .toEqual({ type: 'busy' });

    // The event router writes through the canonical spelling.
    manager.update('C:/Users/me/project/', (state) => ({
      session_status: { ...state.session_status, ses_1: { type: 'idle' } },
    }));
    expect(manager.getState('c:\\Users\\me\\project')?.session_status.ses_1)
      .toEqual({ type: 'idle' });

    manager.disposeAll();
  });

  test('lifecycle bookkeeping shares one key across spellings', () => {
    const manager = new ChildStoreManager();
    manager.ensureChild('C:/Users/me/project', { bootstrap: false });

    manager.pin('c:\\Users\\me\\project');
    expect(manager.pinned('C:/Users/me/project/')).toBe(true);
    // A pinned directory must not be disposable through another spelling.
    expect(manager.disposeDirectory('c:\\Users\\me\\project')).toBe(false);

    manager.unpin('C:/Users/me/project/');
    expect(manager.pinned('c:\\Users\\me\\project')).toBe(false);
    expect(manager.disposeDirectory('C:\\Users\\me\\project')).toBe(true);
    expect(manager.children.size).toBe(0);

    manager.disposeAll();
  });

  test('a capture stays current when re-checked through another spelling', () => {
    const manager = new ChildStoreManager();
    const capture = manager.captureChild('c:\\Users\\me\\project', { bootstrap: false });

    expect(manager.isCurrentChildCapture(capture)).toBe(true);
    expect(manager.isCurrentChildCapture({ ...capture, directory: 'C:/Users/me/project/' }))
      .toBe(true);

    manager.disposeAll();
  });

  test('genuinely different directories keep separate stores', () => {
    const manager = new ChildStoreManager();
    manager.ensureChild('C:/Users/me/project', { bootstrap: false });
    manager.ensureChild('C:/Users/me/other', { bootstrap: false });
    // Case-sensitive filesystems make this a real distinction; only the drive
    // letter is folded, never directory names.
    manager.ensureChild('/home/me/Project', { bootstrap: false });
    manager.ensureChild('/home/me/project', { bootstrap: false });

    expect(manager.children.size).toBe(4);
    manager.disposeAll();
  });
});
