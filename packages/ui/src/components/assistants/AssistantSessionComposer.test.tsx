import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionIndexSnapshot } from '@/lib/session-index-api';

const runtime = vi.hoisted(() => ({ transport: 'runtime-a', load: vi.fn() }));
vi.mock('@/components/chat/imageSource', () => ({ useRuntimeTransportIdentity: () => runtime.transport }));
vi.mock('@/queries/sessionIndexQueries', () => ({
  sessionIndexSnapshotQueryOptions: (transport: string) => ({
    queryKey: ['session-index', transport], queryFn: ({ signal }: { signal: AbortSignal }) => runtime.load(transport, signal), staleTime: 0,
  }),
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui/textarea', () => ({
  Textarea: React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>((props, ref) => (
    <textarea ref={ref} value={props.value} disabled={props.disabled} onInput={props.onChange as React.FormEventHandler<HTMLTextAreaElement>}
      onCopy={props.onCopy} onCut={props.onCut} onKeyDown={props.onKeyDown} onSelect={props.onSelect} onCompositionStart={props.onCompositionStart} onCompositionEnd={props.onCompositionEnd}
      aria-controls={props['aria-controls']} aria-activedescendant={props['aria-activedescendant']} />
  )),
}));

import { AssistantSessionComposer } from './AssistantSessionComposer';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const session = (id: string, title: string, updated: number): Session => ({
  id, title, directory: '/stale-row-path', projectID: 'project', slug: id, version: '1', time: { created: 1, updated },
});
const snapshot = (): SessionIndexSnapshot => ({
  revision: 1,
  sync: { active: false, completed: 2, total: 2, pendingDirectories: [], completedDirectories: [], failedDirectories: [] },
  directories: ['/repo/one', '/repo/two'].map((directory, index) => ({
    directory, cursor: null, hasMore: true, lastSyncedAt: 1, lastFullSyncedAt: 1, lastAccessedAt: 1,
    sessions: [session(`ses_${index}`, 'Shared "title"', 20 - index)],
  })),
});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let draft = '';
let mobile = false;
let active = true;
let working = false;
const stop = vi.fn();
const submit = vi.fn();
const render = () => root.render(<QueryClientProvider client={client}><main><AssistantSessionComposer
  key={runtime.transport} active={active} working={working} onStop={stop} stopLabel="Stop generating" value={draft} isMobile={mobile} autoResize={false}
  onChange={(value) => { draft = value; render(); }} onSubmit={submit}
/></main></QueryClientProvider>);
const input = () => host.querySelector('textarea')!;
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };
const type = async (value: string, cursor = value.length, inputType = 'insertText') => {
  await act(async () => {
    input().value = value;
    input().setSelectionRange(cursor, cursor);
    input().dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
  });
  await flush();
};
const key = async (value: string, options: KeyboardEventInit = {}) => {
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })); });
};
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));

beforeEach(async () => {
  runtime.transport = 'runtime-a'; runtime.load.mockReset().mockResolvedValue(snapshot()); submit.mockReset();
  draft = ''; mobile = false; active = true; working = false; stop.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => render());
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });

test('mounts only for @, searches the bounded snapshot once, and shows directory disambiguation', async () => {
  expect(runtime.load).not.toHaveBeenCalled();
  await type('@');
  expect(rows()).toHaveLength(2);
  expect(rows().map((row) => row.textContent)).toEqual(['Shared "title"/repo/one', 'Shared "title"/repo/two']);
  await type('@Shared');
  await type('@missing');
  expect(rows()).toHaveLength(0);
  expect(document.body.textContent).toContain('sessions.sidebar.empty.noMatches.title');
  expect(runtime.load).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});

test('keyboard selection uses the shared chip display and canonical session codec', async () => {
  await type('Watch @Sh please', 9);
  await key('ArrowDown');
  expect(input().getAttribute('aria-activedescendant')).toBe(rows()[1].id);
  await key('Enter');
  expect(draft).toBe('Watch @session:ses_1 please');
  expect(input().value).toContain('Shared "title"');
  expect(input().value).not.toContain('session:');
  expect(host.querySelector('[data-composer-highlight]')?.textContent).toContain('Shared "title"');
  expect(rows()).toHaveLength(0);
  expect(submit).not.toHaveBeenCalled();
  expect(input().selectionStart).toBe(input().value.indexOf('please'));
  await key('Enter');
  expect(submit).toHaveBeenCalledTimes(1);
});

test('Tab accepts, Escape and outside press cancel while retaining the draft', async () => {
  await type('@Shared'); await key('Escape');
  expect(draft).toBe('@Shared'); expect(rows()).toHaveLength(0);
  await type('@Share');
  await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
  expect(rows()).toHaveLength(0); expect(draft).toBe('@Share');
  await type('@Shared'); await key('Tab');
  expect(draft).toContain('@session:ses_0'); expect(submit).not.toHaveBeenCalled();
});

test('email, pasted references, and IME confirmation preserve ordinary text ownership', async () => {
  await type('person@example'); expect(rows()).toHaveLength(0);
  await type('@Shared', 7, 'insertFromPaste'); expect(rows()).toHaveLength(0);
  await act(async () => { input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
  await type('@Sh'); await key('Enter', { isComposing: true });
  expect(rows()).toHaveLength(0); expect(submit).not.toHaveBeenCalled();
  await key('Enter'); expect(submit).not.toHaveBeenCalled();
  await act(async () => { input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
  await flush(); expect(rows()).toHaveLength(2); expect(draft).toBe('@Sh');
});

test('mobile touch scrolling preserves the draft and a tap selects once through the shared portal', async () => {
  mobile = true; await act(async () => render()); await type('@');
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  const pointer = async (target: HTMLElement, type: string, y: number) => act(async () => {
    target.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', clientX: 10, clientY: y, bubbles: true, cancelable: true }));
  });
  const row = rows()[0];
  await pointer(row, 'pointerdown', 10); await pointer(row, 'pointermove', 35); await pointer(row, 'pointerup', 35);
  await act(async () => row.click()); expect(draft).toBe('@');
  await pointer(row, 'pointerdown', 10); await pointer(row, 'pointerup', 10);
  expect(draft.match(/@session:/g)).toHaveLength(1); expect(rows()).toHaveLength(0); expect(submit).not.toHaveBeenCalled();
});

test('loading and failed refresh remain distinct from empty success; retry retains cached rows', async () => {
  runtime.load.mockImplementationOnce(() => new Promise(() => {}));
  await type('@'); expect(document.body.textContent).toContain('common.loading');
  await key('Escape');
  client.setQueryData(['session-index', runtime.transport], snapshot());
  runtime.load.mockRejectedValueOnce(new Error('offline'));
  await type('@S');
  expect(rows()).toHaveLength(2);
  expect(document.body.textContent).toContain('assistants.contact.sessionMention.loadFailed');
  expect(document.body.textContent).not.toContain('sessions.sidebar.empty.noMatches.title');
  const retry = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'chat.history.retry')!;
  await act(async () => retry.click()); await flush();
  expect(document.querySelector('[role="alert"]')).toBeNull(); expect(rows()).toHaveLength(2);
});

test('inactive and runtime changes close candidates; late results stay in their captured runtime', async () => {
  let resolve!: (value: SessionIndexSnapshot) => void;
  runtime.load.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await type('@');
  runtime.transport = 'runtime-b'; await act(async () => render());
  await act(async () => resolve(snapshot())); await flush(); expect(rows()).toHaveLength(0);
  runtime.load.mockResolvedValueOnce({ ...snapshot(), directories: [] });
  await type('@S'); expect(rows()).toHaveLength(0);
  expect(runtime.load.mock.calls.at(-1)?.[0]).toBe('runtime-b');
  active = false; await act(async () => render());
  expect(document.querySelector('[role="listbox"]')).toBeNull(); expect(draft).toBe('@S');
});

test('unsupported snapshot is explicitly unavailable and closed autocomplete consumes no requests', async () => {
  runtime.load.mockResolvedValueOnce(null); await type('@');
  expect(document.body.textContent).toContain('common.unavailable');
  await key('Escape'); await act(async () => render());
  expect(runtime.load).toHaveBeenCalledTimes(1);
});

test('large bounded snapshots keep rendered rows capped and ordinary parent renders reuse the query', async () => {
  const data = snapshot();
  data.directories = Array.from({ length: 200 }, (_, directoryIndex) => ({
    ...data.directories[0], directory: `/repo/${directoryIndex}`,
    sessions: Array.from({ length: 20 }, (_, index) => session(`ses_${directoryIndex}_${index}`, `Work ${index}`, index)),
  }));
  data.directories[0].sessions.push({ ...session('ses_archived', 'Archived only', 100), time: { created: 1, updated: 100, archived: 100 } });
  runtime.load.mockResolvedValueOnce(data);
  await type('@'); expect(rows()).toHaveLength(3);
  await type('@Work'); expect(rows()).toHaveLength(10);
  for (let index = 0; index < 20; index += 1) await act(async () => render());
  expect(runtime.load).toHaveBeenCalledTimes(1);
  await type('@Archived'); expect(rows()).toHaveLength(0);
});


test('working contact exposes stop while keeping the draft editable for a follow-up', async () => {
  working = true;
  await act(async () => render());
  const button = host.querySelector<HTMLButtonElement>('[data-composer-stop]');
  expect(button?.getAttribute('aria-label')).toBe('Stop generating');
  expect(input().disabled).toBe(false);
  await act(async () => button!.click());
  expect(stop).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
  await type('A follow-up');
  await key('Enter');
  expect(submit).toHaveBeenCalledTimes(1);
});


test('shared reference deletion and undo keep canonical identity and surrounding text', async () => {
  await type('Read @Sh please', 8);
  await key('Enter');
  const selected = draft;
  const chipEnd = input().value.indexOf(' please');
  input().setSelectionRange(chipEnd, chipEnd);
  await key('Backspace');
  expect(draft).toBe('Read  please');
  expect(host.querySelector('[data-composer-highlight]')).toBeNull();
  await key('z', { ctrlKey: true });
  expect(draft).toBe(selected);
  expect(host.querySelector('[data-composer-highlight]')?.textContent).toContain('Shared "title"');
  await key('z', { ctrlKey: true, shiftKey: true });
  expect(draft).toBe('Read  please');
});

test('external canonical drafts materialize using the same session codec and reset cleanly', async () => {
  draft = 'Read @session:ses_external'; await act(async () => render());
  expect(input().value).toContain('ses_external');
  expect(input().value).not.toContain('session:');
  expect(host.querySelector('[data-composer-highlight]')).not.toBeNull();
  draft = ''; await act(async () => render());
  expect(input().value).toBe('');
  expect(host.querySelector('[data-composer-highlight]')).toBeNull();
});


test('copy and cut serialize the shared canonical identity instead of a display label', async () => {
  await type('@Sh'); await key('Enter');
  const start = input().value.indexOf('@');
  input().setSelectionRange(start + 1, start + 4);
  const setData = vi.fn();
  const copy = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(copy, 'clipboardData', { value: { setData } });
  await act(async () => input().dispatchEvent(copy));
  expect(setData).toHaveBeenLastCalledWith('text/plain', '@session:ses_0');
  expect(draft).toContain('@session:ses_0');
  input().setSelectionRange(start + 1, start + 4);
  const cut = new Event('cut', { bubbles: true, cancelable: true });
  Object.defineProperty(cut, 'clipboardData', { value: { setData } });
  await act(async () => input().dispatchEvent(cut));
  expect(draft).not.toContain('@session:');
});
