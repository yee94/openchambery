import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/v2-types';
import { useUIStore } from '@/stores/useUIStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getMobileWindowMotionController, MOBILE_SESSIONS_WINDOW_ID } from '@/components/ui/MobileWindowMotionRegistry';
import { MobileSessionStatusBar } from './MobileSessionStatusBar';
import { buildMobileSessionStatusList } from './mobileSessionStatusBarList';

vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
}));
vi.mock('@/sync/sync-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/sync/sync-context')>(),
  useAllLiveSessions: () => liveSessions,
  useAllSessionStatuses: () => statuses,
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => runtime }));
vi.mock('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: theme }) }));
vi.mock('@/queries/sessionIndexPinQueries', () => ({
  usePinnedSessionIds: () => pins,
  useTogglePinnedSession: () => () => undefined,
}));
vi.mock('@/components/session/sidebar/hooks/useAlwaysVisibleSessionIds', () => ({
  useAlwaysVisibleSessionIds: () => pins,
}));
vi.mock('@/components/session/NewWorktreeDialog', () => ({ NewWorktreeDialog: () => null }));
vi.mock('@/apps/MobileDeleteWorktreeDialog', () => ({ MobileDeleteWorktreeDialog: () => null }));
vi.mock('@/apps/MobileProjectEditSurface', () => ({ MobileProjectEditSurface: () => null }));
vi.mock('./mobileSessionStatusBarList', async (importOriginal) => {
  const original = await importOriginal<typeof import('./mobileSessionStatusBarList')>();
  return { ...original, buildMobileSessionStatusList: vi.fn(original.buildMobileSessionStatusList) };
});

const { liveSessions, statuses, pins, runtime, theme } = vi.hoisted(() => ({
  liveSessions: [], statuses: {}, pins: new Set<string>(),
  runtime: { git: { checkIsGitRepository: async () => false } },
  theme: { metadata: { variant: 'dark' }, colors: { surface: { foreground: 'white' } } },
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  pins.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
    removeEventListener: vi.fn(), dispatchEvent: () => true,
  }));
  useUIStore.setState({ isMobile: true, mobileSessionPanelOpen: false, mobileSessionFilterProjectId: null });
  useProjectsStore.setState({ projects: [], activeProjectId: null });
  useGlobalSessionsStore.setState({ activeSessions: [{
    id: 'ses-cached', title: 'Cached recent conversation', directory: '/project',
    time: { created: 1, updated: 1 },
  } as Session] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  document.getElementById('mobile-overlay-root')?.remove();
  vi.restoreAllMocks();
});

test.each([null, 'project', '__pinned_sessions__'])('cached rows are visible before releasing every gesture in scope %s', async (filter) => {
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project', addedAt: 1 }] });
  pins.add('ses-cached');
  useUIStore.setState({ mobileSessionFilterProjectId: filter });
  await act(async () => root.render(
    <QueryClientProvider client={client}><I18nProvider><MobileSessionStatusBar /></I18nProvider></QueryClientProvider>,
  ));
  const controller = getMobileWindowMotionController(MOBILE_SESSIONS_WINDOW_ID)!;
  await act(async () => useUIStore.getState().setMobileSessionPanelOpen(true));
  expect(document.querySelector('[data-mobile-session-context-trigger="ses-cached"]')).not.toBeNull();
  await act(async () => useUIStore.getState().setMobileSessionPanelOpen(false));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await act(async () => { controller.begin('present'); controller.update(0.5); });
    expect(useUIStore.getState().mobileSessionPanelOpen).toBe(false);
    expect(useGlobalSessionsStore.getState().activeSessions).toHaveLength(1);
    expect(document.querySelector('[data-mobile-session-context-trigger="ses-cached"]')).not.toBeNull();
    await act(async () => controller.finish(attempt === 1 ? 'cancel' : 'commit'));
    await act(async () => useUIStore.getState().setMobileSessionPanelOpen(false));
  }
});

test('first preview uses the existing catalog and hidden catalog updates do not build lists', async () => {
  await act(async () => root.render(
    <QueryClientProvider client={client}><I18nProvider><MobileSessionStatusBar /></I18nProvider></QueryClientProvider>,
  ));
  vi.mocked(buildMobileSessionStatusList).mockClear();
  await act(async () => useGlobalSessionsStore.setState((state) => ({
    activeSessions: state.activeSessions.map((session) => ({ ...session, title: 'Updated while closed' })),
  })));
  expect(vi.mocked(buildMobileSessionStatusList).mock.calls.every((call) => !call[3])).toBe(true);
  const controller = getMobileWindowMotionController(MOBILE_SESSIONS_WINDOW_ID)!;
  await act(async () => { controller.begin('present'); controller.update(0.5); });
  expect(document.querySelector('[data-mobile-session-context-trigger="ses-cached"]')?.textContent).toContain('Updated while closed');
  vi.mocked(buildMobileSessionStatusList).mockClear();
  await act(async () => {
    for (let frame = 1; frame <= 60; frame += 1) controller.update(frame / 60);
  });
  expect(buildMobileSessionStatusList).not.toHaveBeenCalled();
  await act(async () => controller.finish('cancel'));
});
