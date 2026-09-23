import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNotificationStore } from '@/sync/notification-store';
import { SessionErrorNotice } from './SessionErrorNotice';

const state = vi.hoisted(() => ({ errorAt: 100 as number | undefined }));
vi.mock('@/sync/sync-context', () => ({ useSessionErrorAt: () => state.errorAt }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useNotificationStore.setState({ list: [] }); state.errorAt = 100;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(sessionId = 'test-session', directory = '/test-project', hasInlineError = false) {
  await act(async () => root.render(<SessionErrorNotice sessionId={sessionId} directory={directory} hasInlineError={hasInlineError} />));
}
async function report(message: string | null = 'Agent not found: "Build"', directory = '/test-project') {
  await act(async () => useNotificationStore.getState().append({ type: 'error', session: 'test-session', directory, time: Date.now(), viewed: true, error: { name: 'unknown', message } }));
}
it('renders a viewed execution failure even when the failed turn has no assistant message', async () => {
  await render(); await report();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Agent not found: "Build"');
});
it('keeps the composer notice placement and uses workspace chip styling for long errors', async () => {
  const message = `xAI request failed (400): ${'long_error_detail_'.repeat(40)}`;
  await render(); await report(message);
  const notice = host.querySelector('[data-session-error="test-session"]');
  const alert = notice?.querySelector('[role="alert"]');
  expect(notice?.className).toBe('chat-column pb-2');
  expect(alert?.classList.contains('typography-meta')).toBe(true);
  expect(alert?.classList.contains('text-muted-foreground')).toBe(true);
  expect(alert?.classList.contains('rounded-lg')).toBe(true);
  expect(alert?.classList.contains('py-0.5')).toBe(true);
  expect(alert?.querySelector('span')?.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
  expect(alert?.textContent).toBe(message);
});
it('clears the error when authoritative activity clears error_at', async () => {
  await render(); await report(); state.errorAt = undefined; await render();
  expect(host.textContent).toBe('');
});
it('isolates session and directory and suppresses an existing inline assistant error', async () => {
  await render(); await report(); await render('another-session'); expect(host.textContent).toBe('');
  await render('test-session', '/another-project'); expect(host.textContent).toBe('');
  await render('test-session', '/test-project', true); expect(host.textContent).toBe('');
});
it('uses localized fallback copy when the authority provides no error detail', async () => {
  await render(); await act(async () => useNotificationStore.getState().append({ type: 'error', session: 'test-session', directory: '/test-project', time: Date.now(), viewed: false }));
  expect(host.textContent).toContain('chat.chatInput.toast.messageSendFailed');
});
it('shows the latest same-session failure without exposing another session error', async () => {
  await render(); await report('first failure'); await report('latest failure');
  await act(async () => useNotificationStore.getState().append({ type: 'error', session: 'other-session', time: Date.now(), viewed: false, error: { name: null, message: 'unrelated' } }));
  expect(host.textContent).toContain('latest failure'); expect(host.textContent).not.toContain('unrelated');
});
