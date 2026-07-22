import { describe, expect, test } from 'bun:test';
import { ChildStoreManager } from '../child-store';
import { shouldBootstrapDirectory } from '../sync-context';

describe('ChildStoreManager lightweight subscribers', () => {
  test('creates a subscribable store without starting directory bootstrap', () => {
    const manager = new ChildStoreManager();
    const bootstrapped: string[] = [];
    manager.configure({ onBootstrap: (directory) => bootstrapped.push(directory) });

    const store = manager.ensureChild('/sidebar-only', { bootstrap: false });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    store.getState().patch({ session_status: { session: { type: 'busy' } } });
    unsubscribe();

    expect(bootstrapped).toEqual([]);
    expect(notifications).toBe(1);
  });

  test('still starts bootstrap for an authoritative directory consumer', () => {
    const manager = new ChildStoreManager();
    const bootstrapped: string[] = [];
    manager.configure({ onBootstrap: (directory) => bootstrapped.push(directory) });

    manager.ensureChild('/active-chat');

    expect(bootstrapped).toEqual(['/active-chat']);
  });

  test('defers a draft directory bootstrap and starts it once when its gate opens', () => {
    const manager = new ChildStoreManager();
    let bootstrapCurrentDirectory = false;
    let bootstrapCount = 0;
    manager.configure({
      onBootstrap: (directory) => {
        if (!shouldBootstrapDirectory(directory, '/draft', bootstrapCurrentDirectory)) return;
        bootstrapCount += 1;
        manager.getChild(directory)?.setState({ status: 'complete' });
      },
    });

    const draftStore = manager.ensureChild('/draft', { bootstrap: false });
    draftStore.setState({ session_status: { optimistic: { type: 'busy' } } });
    manager.ensureChild('/draft', { bootstrap: false });
    expect(bootstrapCount).toBe(0);
    expect(draftStore.getState().status).toBe('loading');
    expect(draftStore.getState().session_status.optimistic).toEqual({ type: 'busy' });

    bootstrapCurrentDirectory = true;
    manager.ensureChild('/draft');
    manager.ensureChild('/draft');
    expect(bootstrapCount).toBe(1);
  });

  test('keeps reconnect and directory changes scoped to the active bootstrap gate', () => {
    expect(shouldBootstrapDirectory('/default', '/default')).toBe(true);
    expect(shouldBootstrapDirectory('/draft', '/draft', false)).toBe(false);
    expect(shouldBootstrapDirectory('/draft', '/draft', true)).toBe(true);
    expect(shouldBootstrapDirectory('/existing-session', '/draft', false)).toBe(true);
    expect(shouldBootstrapDirectory('/next-draft', '/next-draft', false)).toBe(false);
  });
});
