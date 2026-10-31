import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { setActiveChatInputSurface } from '@/components/chat/activeChatInputSurface';
import type { ChatInputSurface } from '@/components/chat/chatInputSurface';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

const mocks = vi.hoisted(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
  return { cycle: vi.fn() };
});
vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ themeMode: 'dark', setThemeMode: vi.fn() }),
}));
vi.mock('@/hooks/useAssistantStatus', () => ({
  useAssistantStatus: () => ({ working: { canAbort: false } }),
}));

const surface: ChatInputSurface = {
  kind: 'primary', surfaceID: 'primary', active: true,
  sessionID: 'session-input', directory: '/workspace',
  draftKey: { transportIdentity: 'local', owner: { kind: 'session', ownerID: 'session-input' } },
  transportIdentity: 'local', runtimeGeneration: 1,
  deliveryTarget: { kind: 'primary' },
  selection: { value: { agent: 'build' }, flush: async () => {} },
  backend: {
    send: async () => {}, sendQueued: async () => {}, create: async () => {},
    compact: async () => {}, abort: async () => {},
  },
  shortcuts: { cycle: mocks.cycle, new: () => {}, abort: () => {}, submit: () => {} },
};

let root: Root;
let textarea: HTMLTextAreaElement;
function Harness() {
  useKeyboardShortcuts();
  return <textarea data-chat-input="true" />;
}
beforeEach(async () => {
  useUIStore.setState({ ...useUIStore.getInitialState(), activeMainTab: 'chat', shortcutOverrides: {} });
  useSessionUIStore.setState({ ...useSessionUIStore.getInitialState(), currentSessionId: 'session-input' });
  setActiveChatInputSurface(surface);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  textarea = host.querySelector('textarea')!;
  textarea.focus();
});
afterEach(async () => {
  await act(async () => root.unmount());
  setActiveChatInputSurface(null);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  mocks.cycle.mockClear();
});
afterAll(() => vi.unstubAllGlobals());

async function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => { textarea.dispatchEvent(event); });
  return event;
}

test('typing Tab or inserting a tab character does not cycle agents', async () => {
  for (const [key, code] of [['T', 'KeyT'], ['a', 'KeyA'], ['b', 'KeyB']]) {
    expect((await press({ key, code, shiftKey: key === 'T' })).defaultPrevented).toBe(false);
  }
  for (const [inputType, data] of [['insertText', 'Tab'], ['insertFromPaste', '\t']]) {
    await act(async () => {
      textarea.value += data;
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }));
    });
  }
  expect(textarea.value).toBe('Tab\t');
  expect(mocks.cycle).not.toHaveBeenCalled();
});

test.each([
  { isComposing: true },
  { keyCode: 229 },
])('IME Tab stays with text input (%j)', async (composition) => {
  for (let index = 0; index < 50; index += 1) {
    const event = await press({ key: 'Tab', code: 'Tab', ...composition });
    expect(event.defaultPrevented).toBe(false);
  }
  expect(mocks.cycle).not.toHaveBeenCalled();
});

test('Tab and Shift+Tab shortcuts still cycle once in each direction', async () => {
  expect((await press({ key: 'Tab', code: 'Tab' })).defaultPrevented).toBe(true);
  expect((await press({ key: 'Tab', code: 'Tab', shiftKey: true })).defaultPrevented).toBe(true);
  expect(mocks.cycle.mock.calls).toEqual([[1], [-1]]);
});

test('a Tab consumed by the input never cycles again in the global listener', async () => {
  textarea.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
  await press({ key: 'Tab', code: 'Tab' });
  expect(mocks.cycle).not.toHaveBeenCalled();
});
