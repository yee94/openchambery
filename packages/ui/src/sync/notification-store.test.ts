import { beforeEach, describe, expect, test } from 'bun:test';
import { useNotificationStore } from './notification-store';

describe('notification store', () => {
  beforeEach(() => {
    useNotificationStore.setState({
      list: [],
      index: {
        session: { unseenCount: {}, unseenHasError: {} },
        project: { unseenCount: {}, unseenHasError: {} },
      },
    });
  });

  test('clears a completed session marker when the session is viewed', () => {
    const store = useNotificationStore.getState();
    store.append({
      directory: '/project',
      session: 'root-session',
      time: Date.now(),
      viewed: false,
      type: 'turn-complete',
    });

    expect(useNotificationStore.getState().sessionUnseenCount('root-session')).toBe(1);

    useNotificationStore.getState().markSessionViewed('root-session');

    expect(useNotificationStore.getState().sessionUnseenCount('root-session')).toBe(0);
  });

  test('clearSessionErrorNotifications removes error rows for one session only', async () => {
    const { clearSessionErrorNotifications } = await import('./notification-store');
    const store = useNotificationStore.getState();
    const now = Date.now();
    store.append({
      directory: '/project',
      session: 'ses_a',
      time: now,
      viewed: false,
      type: 'error',
      error: { name: 'provider.auth', message: '401' },
    });
    store.append({
      directory: '/project',
      session: 'ses_b',
      time: now + 1,
      viewed: false,
      type: 'error',
      error: { name: 'unknown', message: 'keep' },
    });

    clearSessionErrorNotifications('ses_a');

    const list = useNotificationStore.getState().list;
    expect(list.some((n) => n.session === 'ses_a' && n.type === 'error')).toBe(false);
    expect(list.some((n) => n.session === 'ses_b' && n.type === 'error')).toBe(true);
  });
});
