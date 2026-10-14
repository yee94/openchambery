import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ unread: 0 }));
vi.mock('@/queries/assistantQueries', () => ({ useAssistantUnreadTotal: () => state.unread }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import { MobileTabBar } from './MobileTabBar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
const root = createRoot(host);
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  state.unread = 0;
});

test('loading badges yield to unread and stay off other tabs', async () => {
  document.body.append(host);
  state.unread = 0;
  await act(async () => root.render(
    <MobileTabBar activeTab="projects" onTabChange={() => undefined} tabMarks={{ assistant: 'loading', scheduled: 'loading' }} />,
  ));
  expect(host.querySelector('[data-tab="assistant"] [data-mobile-tab-activity="loading"]')).not.toBeNull();
  expect(host.querySelector('[data-tab="scheduled"] [data-mobile-tab-activity="loading"]')).not.toBeNull();
  expect(host.querySelector('[data-tab="projects"] [data-mobile-tab-activity]')).toBeNull();
  expect(host.querySelector('[data-assistant-unread-count]')).toBeNull();
  expect(host.querySelector('#mobile-tab-assistant-activity')?.getAttribute('aria-label')).toBe('mobile.tabs.activity.loading');

  state.unread = 4;
  await act(async () => root.render(
    <MobileTabBar activeTab="assistant" onTabChange={() => undefined} tabMarks={{ assistant: 'loading', scheduled: 'loading' }} />,
  ));
  expect(host.querySelector('[data-tab="assistant"] [data-mobile-tab-activity]')).toBeNull();
  expect(host.querySelector('[data-tab="assistant"] [data-assistant-unread-count]')?.textContent).toBe('4');
  expect(host.querySelector('[data-tab="scheduled"] [data-mobile-tab-activity="loading"]')).not.toBeNull();
});
