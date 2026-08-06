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

describe('ChildStoreManager session history boundary', () => {
  test('a fresh child store has no boundary entries — every session reads unknown', () => {
    const manager = new ChildStoreManager();
    const child = manager.ensureChild('/workspace', { bootstrap: false });

    expect(child.getState().session_history_boundary).toEqual({});
    expect(
      child.getState().session_history_boundary['ses_1'] ?? UNKNOWN_SESSION_HISTORY_BOUNDARY,
    ).toEqual({ kind: 'unknown', loadedTurns: 0 });

    manager.disposeAll();
  });

  test('disposing and recreating a directory resets its boundaries to unknown', () => {
    const manager = new ChildStoreManager();
    const original = manager.ensureChild('/workspace', { bootstrap: false });
    original.setState({
      session_history_boundary: {
        ses_1: { kind: 'exhausted', loadedTurns: 4 },
      },
    });

    expect(manager.disposeDirectory('/workspace')).toBe(true);
    const recreated = manager.ensureChild('/workspace', { bootstrap: false });
    expect(recreated.getState().session_history_boundary).toEqual({});

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
