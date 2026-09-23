import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FormCard } from './FormCard';

const mocks = vi.hoisted(() => ({ reply: vi.fn(), cancel: vi.fn(), remove: vi.fn() }));
vi.mock('@/sync/session-form-api', () => ({ postSessionFormReply: mocks.reply, postSessionFormCancel: mocks.cancel }));
vi.mock('@/sync/session-form-store', () => ({ useSessionFormStore: { getState: () => ({ remove: mocks.remove }) } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const form = { id: 'frm_choice', sessionID: 'session', title: 'Choose target', fields: [
  { key: 'target', type: 'string' as const, required: true, options: [{ label: 'Web', value: 'web' }, { label: 'Mobile', value: 'mobile' }] },
] };
async function render() { await act(async () => root.render(<FormCard form={form} directory="/workspace" />)); }
async function submit() {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'chat.form.reply');
  await act(async () => button?.click());
}
test('submits the visible initial option using its value', async () => {
  await render(); await submit();
  expect(mocks.reply).toHaveBeenCalledWith({ sessionID: 'session', formID: 'frm_choice', directory: '/workspace', answer: { target: 'web' } });
});
test('keeps the form and exposes submission failure for retry', async () => {
  mocks.reply.mockRejectedValueOnce(new Error('Request failed'));
  await render(); await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('chat.questionCard.submitFailed');
  expect(mocks.remove).not.toHaveBeenCalled();
  await submit();
  expect(mocks.reply).toHaveBeenCalledTimes(2);
  expect(mocks.remove).toHaveBeenCalledWith('session', 'frm_choice');
});
test('option chips submit the selected wire value and use shared selection semantics', async () => {
  await render();
  const mobile = [...host.querySelectorAll('button')].find((item) => item.textContent === 'Mobile');
  await act(async () => mobile?.click());
  expect(mobile?.getAttribute('aria-pressed')).toBe('true');
  await submit();
  expect(mocks.reply.mock.calls[0][0].answer).toEqual({ target: 'mobile' });
});
