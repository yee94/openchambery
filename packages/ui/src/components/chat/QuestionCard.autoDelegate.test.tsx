import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), reply: vi.fn(), reject: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('@/sync/session-actions', () => ({ respondToQuestion: mocks.reply, rejectQuestion: mocks.reject, isQuestionRequestNotFoundError: () => false,
  isQuestionSubmissionClaimedError: (error: { status?: number; code?: string }) => error.status === 409 && error.code === 'question_submission_claimed',
}));
vi.mock('@/sync/sync-context', () => ({ useSessions: () => [{ id: 'child', parentID: 'parent', directory: '/child-project' }] }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: (select: (state: { currentSessionId: string }) => unknown) => select({ currentSessionId: 'parent' }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: { isMobile: boolean }) => unknown) => select({ isMobile: false }) }));
vi.mock('@/components/ui', () => ({ toast: { success: mocks.success, error: mocks.error, info: vi.fn() } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/i18n', async () => {
  const { dict } = await import('@/lib/i18n/messages/en');
  return { useI18n: () => ({ t: (key: keyof typeof dict, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce<string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), dict[key]) }) };
});
import { queryClient } from '@/lib/queryRuntime';
import { questionAutoDelegateQueryOptions, refreshQuestionAutoDelegate, type QuestionDelegateData } from '@/lib/questionAutoDelegate';
import { QuestionCard } from './QuestionCard';
import { QuestionAutoDelegateNotifications } from './QuestionAutoDelegateStatus';
import type { QuestionRequest } from '@/types/question';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const question: QuestionRequest = { id: 'q-1', sessionID: 'child', questions: [
  { header: 'First', question: 'Choose one', options: [{ label: 'Option A', description: '' }] },
  { header: 'Second', question: 'Choose two', options: [{ label: 'Option B', description: '' }] },
] };
let root: Root;
let host: HTMLDivElement;
let snapshot: QuestionDelegateData['snapshot'];
const posts = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(5); }); };
const button = (text: string) => {
  const found = [...host.querySelectorAll('button')].find((node) => node.textContent === text);
  if (!found) throw new Error(`Missing button ${text}: ${host.textContent}`);
  return found;
};
async function click(text: string) { await act(async () => { button(text).click(); }); await flush(); }
async function publish() {
  await act(async () => { await refreshQuestionAutoDelegate(); });
  await flush();
}
async function mount() {
  await queryClient.fetchQuery(questionAutoDelegateQueryOptions());
  await act(async () => { root.render(<><QuestionAutoDelegateNotifications /><QuestionCard question={question} /></>); });
  await flush();
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.setSystemTime(new Date('2040-01-01'));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  mocks.fetch.mockReset(); mocks.reply.mockReset(); mocks.reject.mockReset(); mocks.success.mockReset(); mocks.error.mockReset();
  snapshot = { epoch: 'host-a', revision: 1, serverNow: 1000, enabled: true, delayMs: 30000,
    coverage: { state: 'ready', failedDirectories: [] },
    requests: [{ requestID: 'q-1', sessionID: 'child', directory: '/child-project', questionCount: 2,
      state: 'counting', deadlineAt: 31000, pauseReason: null, submittedBy: null, resolution: null }],
  };
  mocks.fetch.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, requests: [{ ...snapshot.requests[0], state: 'paused', deadlineAt: null, pauseReason: 'interaction' }] };
      return Response.json({ outcome: 'paused', snapshot });
    }
    return Response.json(snapshot);
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); queryClient.clear(); host.remove(); vi.useRealTimers(); vi.restoreAllMocks();
});

const bar = () => host.querySelector<HTMLElement>('[data-question-delegate-bar]');

describe('QuestionCard auto delegation', () => {
  test('shows a full-width countdown bar before the host snapshot arrives', async () => {
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    await act(async () => { root.render(<QuestionCard question={question} />); });
    await flush();
    expect(host.textContent).not.toContain('Loading...');
    expect(host.textContent).toContain('Model decides in 30s');
    expect(bar()?.className).toContain('h-1');
    expect(bar()?.className).toContain('w-full');
  });
  test('keeps the countdown bar when the snapshot has not yet listed this question', async () => {
    snapshot = { ...snapshot, requests: [] };
    await mount();
    expect(host.textContent).not.toContain('Loading...');
    expect(host.textContent).toContain('Model decides in 30s');
    expect(bar()).toBeTruthy();
  });
  test('matches the host countdown by request id even when session ids differ', async () => {
    snapshot = { ...snapshot, requests: [{ ...snapshot.requests[0], sessionID: 'other-session' }] };
    await mount();
    expect(host.textContent).toContain('Model decides in 30s');
    expect(bar()).toBeTruthy();
  });
  test('server-relative countdown updates locally and expiry submits no browser answer', async () => {
    await mount();
    expect(host.textContent).toContain('Model decides in 30s');
    expect(bar()?.className).toContain('h-1');
    const gets = mocks.fetch.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(host.textContent).toContain('Model decides in 25s');
    expect(mocks.fetch).toHaveBeenCalledTimes(gets);
    await act(async () => { await vi.advanceTimersByTimeAsync(25000); });
    expect(host.textContent).toContain('Waiting for host confirmation');
    expect(posts()).toHaveLength(0); expect(mocks.reply).not.toHaveBeenCalled();
    expect(host.querySelector('[style*="scaleX(0)"]')).toBeTruthy();
  });
  test('option and tab interactions pause using the child identity and preserve attribution', async () => {
    await mount();
    expect(host.textContent).toContain('From subagent');
    await click('Option A');
    expect(JSON.parse(posts()[0][1].body)).toEqual({ sessionID: 'child', directory: '/child-project', reason: 'interaction' });
    expect(host.textContent).toContain('Countdown paused');
    await click('Second');
    expect(posts()).toHaveLength(1);
    await click('Option B');
    await click('Submit');
    expect(mocks.reply).toHaveBeenCalledWith('child', 'q-1', [['Option A'], ['Option B']], '/child-project');
  });
  test.each(['input', 'paste', 'compositionstart', 'keydown'])('%s pauses while programmatic focus remains inert', async (type) => {
    await mount(); await click('Other…');
    snapshot = { ...snapshot, revision: snapshot.revision + 1, requests: [{ ...snapshot.requests[0], state: 'counting', deadlineAt: 31000 }] };
    await publish(); mocks.fetch.mockClear();
    const textarea = host.querySelector('textarea')!;
    await act(async () => { textarea.blur(); textarea.focus(); }); await flush();
    expect(posts()).toHaveLength(0);
    await act(async () => { textarea.dispatchEvent(type === 'keydown' ? new KeyboardEvent(type, { key: 'a', bubbles: true }) : new Event(type, { bubbles: true })); });
    await flush();
    expect(posts()).toHaveLength(1);
  });
  test('pause pending is truthful and failure exposes an explicit retry', async () => {
    await mount();
    let fail!: (error: Error) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await click('Pause countdown');
    expect(host.textContent).toContain('Pausing countdown');
    expect(host.textContent).not.toContain('Countdown paused');
    await act(async () => { fail(new Error('offline')); }); await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Pause failed');
    await click('Retry');
    expect(host.textContent).toContain('Countdown paused');
    expect(posts()).toHaveLength(2);
  });
  test('switching question tabs immediately pauses the whole request', async () => {
    await mount(); await click('Second');
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0][1].body).reason).toBe('interaction');
    expect(host.textContent).toContain('Choose two');
  });
  test('immediate delegation confirms success only after an authoritative settled reply', async () => {
    await mount();
    mocks.fetch.mockImplementationOnce(async () => {
      snapshot = { ...snapshot, revision: 2, requests: [{ ...snapshot.requests[0], state: 'settled', submittedBy: 'auto', resolution: 'replied', deadlineAt: null }] };
      return Response.json({ outcome: 'submitted', snapshot });
    });
    await click('Delegate now');
    expect(posts()).toHaveLength(1);
    expect(host.textContent).toContain('Continuation reply sent');
    expect(mocks.success).toHaveBeenCalledTimes(1);
  });
  test('failed delegation preserves the question and exposes retry', async () => {
    await mount(); mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    await click('Delegate now');
    expect(host.textContent).toContain('Delegation failed');
    expect(button('Retry')).toBeTruthy();
    expect(host.querySelector('[data-question-card]')).toBeTruthy();
    expect(mocks.success).not.toHaveBeenCalled();
  });
  test('unrelated manual 409 retains ordinary error handling', async () => {
    await mount(); await click('Option A'); await click('Second'); await click('Option B');
    mocks.reply.mockRejectedValueOnce(Object.assign(new Error('claimed'), { status: 409 }));
    await click('Submit');
    expect(host.querySelector('[data-question-card]')).toBeTruthy();
    expect(button('Submit').disabled).toBe(false);
    expect(mocks.error).toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });
  test.each(['submitting', 'uncertain'] as const)('claimed manual reply refreshes authority and keeps the custom draft in %s', async (state) => {
    await mount(); await click('Other…');
    await act(async () => {
      const textarea = host.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Keep this draft');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Second'); await click('Option B');
    const reads = mocks.fetch.mock.calls.length;
    mocks.reply.mockImplementationOnce(async () => {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, requests: [{ ...snapshot.requests[0], state, deadlineAt: null }] };
      throw Object.assign(new Error('claimed'), { status: 409, code: 'question_submission_claimed' });
    });
    await click('Submit');
    expect(mocks.fetch.mock.calls.length).toBeGreaterThan(reads);
    expect(button('Submit').disabled).toBe(true);
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(host.textContent).toContain(state === 'submitting' ? 'Submitting reply' : 'Submission outcome is uncertain');
    await click('First');
    expect(host.querySelector('textarea')?.value).toBe('Keep this draft');
    await click('Submit');
    expect(mocks.reply).toHaveBeenCalledTimes(1);
  });
  test('claimed dismissal with a stale snapshot offers status refresh and keeps submission locked', async () => {
    await mount(); await click('Option A');
    mocks.reject.mockRejectedValueOnce(Object.assign(new Error('claimed'), { status: 409, code: 'question_submission_claimed' }));
    const reads = mocks.fetch.mock.calls.length;
    await click('Dismiss');
    expect(mocks.fetch.mock.calls.length).toBeGreaterThan(reads);
    expect(host.textContent).toContain('Submission outcome is uncertain');
    expect(button('Dismiss').disabled).toBe(true);
    expect(host.textContent).not.toContain('Delegate now');
    expect(mocks.error).not.toHaveBeenCalled();
    await click('Refresh status');
    expect(mocks.reject).toHaveBeenCalledTimes(1);
  });
  test('automatic countdown off still allows one explicit delegation', async () => {
    snapshot = { ...snapshot, enabled: false, requests: [{ ...snapshot.requests[0], state: 'disabled', deadlineAt: null }] };
    await mount();
    expect(host.textContent).toContain('Automatic countdown is off');
    mocks.fetch.mockImplementationOnce(async () => {
      snapshot = { ...snapshot, revision: 2, requests: [{ ...snapshot.requests[0], state: 'settled', submittedBy: 'auto', resolution: 'replied' }] };
      return Response.json({ outcome: 'submitted', snapshot });
    });
    await click('Delegate now');
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toContain('/delegate');
    expect(snapshot.enabled).toBe(false);
    expect(mocks.success).toHaveBeenCalledTimes(1);
  });
  test('claimed dismissal stays locked after snapshot refresh failure; retry only reads status', async () => {
    await mount(); await click('Option A');
    mocks.reject.mockRejectedValueOnce(Object.assign(new Error('claimed'), { status: 409, code: 'question_submission_claimed' }));
    mocks.fetch.mockRejectedValue(new Error('offline'));
    await click('Dismiss');
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(host.textContent).toContain('Submission outcome is uncertain');
    expect(host.textContent).toContain('Could not refresh delegation status');
    expect(button('Dismiss').disabled).toBe(true);
    await click('Refresh status');
    expect(mocks.reject).toHaveBeenCalledTimes(1);
    expect(mocks.error).not.toHaveBeenCalled();
  });
  test('delegate action bypasses interaction pause and uncertain preserves the card', async () => {
    await mount();
    mocks.fetch.mockImplementationOnce(async () => {
      snapshot = { ...snapshot, revision: 2, requests: [{ ...snapshot.requests[0], state: 'uncertain', submittedBy: 'auto', deadlineAt: null }] };
      return Response.json({ outcome: 'uncertain', snapshot });
    });
    await click('Delegate now');
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toContain('/delegate');
    expect(JSON.parse(posts()[0][1].body)).toEqual({ sessionID: 'child', directory: '/child-project' });
    expect(host.textContent).toContain('Submission outcome is uncertain');
    expect(mocks.success).not.toHaveBeenCalled();
    expect(host.querySelector('[data-question-card]')).toBeTruthy();
  });
  test('confirmed automatic success remains visible after the card unmounts', async () => {
    await mount();
    await act(async () => { root.render(<QuestionAutoDelegateNotifications />); });
    snapshot = { ...snapshot, revision: 2, requests: [{ ...snapshot.requests[0], state: 'settled', submittedBy: 'auto', resolution: 'replied', deadlineAt: null }] };
    await publish();
    expect(mocks.success).toHaveBeenCalledTimes(1);
    await publish();
    expect(mocks.success).toHaveBeenCalledTimes(1);
  });
  test('background clients consume settled snapshots quietly and do not replay success on focus', async () => {
    await mount();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    snapshot = { ...snapshot, revision: 2, requests: [{ ...snapshot.requests[0], state: 'settled', submittedBy: 'auto', resolution: 'replied' }] };
    await publish();
    expect(mocks.success).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await publish();
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
