import React, { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore } from 'zustand/vanilla';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as zh } from '@/lib/i18n/messages/zh-CN';
import { SessionRecoveryNotice } from './SessionRecoveryNotice';

const fixture = vi.hoisted(() => ({ locale: 'en', stores: new Map(), read: vi.fn() }));
vi.mock('@/sync/sync-context', () => ({ useDirectoryStore: (directory: string, options: unknown) => {
  fixture.read(directory, options);
  return fixture.stores.get(directory);
} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof en) => (fixture.locale === 'en' ? en : zh)[key] }) }));
const makeStore = () => createStore(() => ({
  session_execution_recovery: {} as Record<string, { reason: 'shutdown'; observedAt: number }>,
  session_status: { same: { type: 'busy' } },
  connection: 'failed',
}));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.locale = 'en'; fixture.read.mockClear();
  fixture.stores.set('/a', makeStore()); fixture.stores.set('/b', makeStore());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(directory = '/a', sessionId = 'same', onRender = vi.fn()) {
  await act(async () => root.render(<Profiler id="recovery" onRender={onRender}><SessionRecoveryNotice directory={directory} sessionId={sessionId} /></Profiler>));
}
it('renders shutdown confirmation through prolonged connection failure and clears with authority', async () => {
  const store = fixture.stores.get('/a');
  store.setState({ session_execution_recovery: { same: { reason: 'shutdown', observedAt: 1 } } });
  await render();
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Service restarted. Waiting to confirm task status.');
  await act(async () => store.setState({ connection: 'failed-again' }));
  expect(host.textContent).toContain('Waiting to confirm');
  expect(host.querySelector('.animate-spin')).toBeNull();
  fixture.locale = 'zh'; await render();
  expect(host.textContent).toBe('服务重启，等待确认任务状态');
  await act(async () => store.setState({ session_execution_recovery: {} }));
  expect(host.textContent).toBe('');
});
it('isolates directory/session, ignores historical busy and avoids unrelated renders', async () => {
  const store = fixture.stores.get('/a');
  store.setState({ session_execution_recovery: { same: { reason: 'shutdown', observedAt: 1 } } });
  await render('/b'); expect(host.textContent).toBe('');
  await render('/a', 'other'); expect(host.textContent).toBe('');
  const commits = vi.fn(); await render('/a', 'same', commits); commits.mockClear();
  await act(async () => store.setState({ session_execution_recovery: { ...store.getState().session_execution_recovery, other: { reason: 'shutdown', observedAt: 2 } } }));
  expect(commits).not.toHaveBeenCalled();
  expect(fixture.read).toHaveBeenCalledWith('/a', { bootstrap: false });
});
