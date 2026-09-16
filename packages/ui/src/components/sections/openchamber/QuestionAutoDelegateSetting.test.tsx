import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ settings: { save: mocks.save } }) }));
vi.mock('@/lib/i18n', async () => {
  const { dict } = await import('@/lib/i18n/messages/en');
  return { useI18n: () => ({ t: (key: keyof typeof dict) => dict[key] }) };
});
import { QuestionAutoDelegateSetting } from './QuestionAutoDelegateSetting';
import { queryClient } from '@/lib/queryRuntime';
import { questionAutoDelegateQueryOptions } from '@/lib/questionAutoDelegate';
import { buildSettingsSearchResults } from '@/lib/settings/search';
import { dict } from '@/lib/i18n/messages/en';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let enabled: boolean;
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(5); }); };
beforeEach(async () => {
  vi.useFakeTimers(); enabled = true; mocks.save.mockReset(); mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async () => Response.json({ epoch: 'host', revision: enabled ? 1 : 2, serverNow: 0,
    enabled, delayMs: 30000, coverage: { state: 'ready', failedDirectories: [] }, requests: [] }));
  await queryClient.fetchQuery(questionAutoDelegateQueryOptions());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<QuestionAutoDelegateSetting />); });
  await flush();
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); queryClient.clear(); host.remove(); vi.useRealTimers();
});
test('save failure preserves the authoritative value; retry uses RuntimeAPIs.settings.save', async () => {
  const row = () => host.querySelector<HTMLElement>('[data-settings-item="chat.question-auto-delegate"]')!;
  expect(row().getAttribute('aria-pressed')).toBe('true');
  mocks.save.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { row().click(); }); await flush();
  expect(mocks.save).toHaveBeenCalledWith({ questionAutoDelegateEnabled: false });
  expect(row().getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
  mocks.save.mockImplementationOnce(async () => { enabled = false; return { questionAutoDelegateEnabled: false }; });
  await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!.click(); });
  await flush();
  expect(row().getAttribute('aria-pressed')).toBe('false');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
test('chat search includes the same anchor on web, desktop and VS Code', () => {
  for (const platform of ['web', 'desktop', 'vscode']) {
    const results = buildSettingsSearchResults({
      query: 'delegate', visiblePageSlugs: ['chat'], t: (key) => dict[key], getPageTitle: () => 'Chat',
      runtimeCtx: { isWeb: platform === 'web', isDesktop: platform === 'desktop', isVSCode: platform === 'vscode',
        isMobile: false, isDesktopLocalOrigin: platform === 'desktop', isMac: false, isWindows: false },
    });
    expect(results.some((item) => item.id === 'chat.question-auto-delegate')).toBe(true);
    expect(host.querySelector('[data-settings-item="chat.question-auto-delegate"]')).toBeTruthy();
  }
});
