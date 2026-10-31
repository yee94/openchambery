import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ unread: 0, avatar: null as string | null, variant: 'light' }));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => ({ currentTheme: { metadata: { variant: React.useContext(ThemeVariantContext) } } }) }));
vi.mock('@/queries/assistantQueries', () => ({ useAssistantUnreadTotal: () => state.unread, useAssistantSnapshotQuery: () => ({ data: state.avatar ? { seed: state.avatar } : null }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/assistants/ProceduralAssistantAvatar', () => ({
  ProceduralAssistantAvatar: ({ size, motion, randomizeShape, eyeColor }: { size: number; motion: string; randomizeShape: boolean; eyeColor: string }) => (
    <span data-procedural-avatar="" data-size={size} data-motion={motion} data-randomize-shape={String(randomizeShape)} data-eye-color={eyeColor} />
  ),
}));
import { MobileTabBar } from './MobileTabBar';
const ThemeVariantContext = React.createContext('light');

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement('div');
  root = createRoot(host);
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  state.unread = 0;
  state.avatar = null;
  state.variant = 'light';
});

test('Bot navigation artwork stays centered with only gentle enlargement in the shared icon slot', async () => {
  state.avatar = 'navigation';
  await act(async () => root.render(<ThemeVariantContext.Provider value={state.variant}><MobileTabBar activeTab="assistant" onTabChange={() => undefined} /></ThemeVariantContext.Provider>));

  const avatar = host.querySelector('[data-tab="assistant"] [data-assistant-navigation-avatar]');
  expect(avatar).not.toBeNull();
  expect(avatar?.className).toContain('size-[23px]');
  expect(avatar?.className).toContain('items-center justify-center');
  expect(avatar?.className).toContain('[&[data-assistant-navigation-avatar]]:scale-105');
  expect(avatar?.className).not.toContain('scale-125');
  expect(avatar?.parentElement?.className).toContain('size-[23px]');
  const face = avatar?.querySelector('[data-procedural-avatar]');
  expect(face?.getAttribute('data-size')).toBe('23');
  expect(face?.getAttribute('data-motion')).toBe('idle');
  expect(face?.getAttribute('data-randomize-shape')).toBe('true');
  expect(face?.getAttribute('data-eye-color')).toBe('white');
  state.variant = 'dark';
  await act(async () => root.render(<ThemeVariantContext.Provider value={state.variant}><MobileTabBar activeTab="assistant" onTabChange={() => undefined} /></ThemeVariantContext.Provider>));
  expect(host.querySelector('[data-tab="assistant"] [data-procedural-avatar]')?.getAttribute('data-eye-color')).toBe('black');
});

test('loading badges yield to unread and stay off other tabs', async () => {
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
