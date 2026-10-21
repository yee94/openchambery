import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { dict as en } from '@/lib/i18n/messages/en';
import { ContentIndexOnboarding } from './ContentIndexOnboarding';

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), runtime: 'host-a', vscode: false }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => fixture.fetch(...args) }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => fixture.runtime,
  getRuntimeGeneration: () => 0,
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useIsVSCodeRuntime: () => fixture.vscode }));
vi.mock('./ChooserScreen', () => ({ ChooserScreen: () => null }));
vi.mock('./LocalSetupScreen', () => ({ LocalSetupScreen: () => null }));
vi.mock('./RecoveryScreen', () => ({ RecoveryScreen: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({
  t: (key: keyof typeof en, params?: Record<string, string | number>) => {
    let text: string = en[key] ?? key;
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  },
}) }));

const progress = (patch: Record<string, unknown> = {}) => ({
  phase: 'indexing', total: 10, completed: 3, failed: 0, messages: 20,
  initializationRequired: true, indexStartedAt: 100, indexCompletedAt: null, updatedAt: null,
  ...patch,
});
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const render = async () => {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><ContentIndexOnboarding /></QueryClientProvider>);
    await vi.advanceTimersByTimeAsync(1);
  });
};
const tick = async (ms = 3000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  fixture.fetch.mockReset();
  fixture.runtime = 'host-a';
  fixture.vscode = false;
  fixture.fetch.mockImplementation(async () => Response.json({ index: progress() }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await import('./OnboardingScreen');
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.useRealTimers();
});

test('shows the shared onboarding step, preserves progress on failure, and stops polling after complete verification', async () => {
  await render();
  await tick(1);
  expect(document.body.textContent).toContain('Initializing full-text search');
  expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('3');
  fixture.fetch.mockRejectedValue(new Error('offline'));
  await tick();
  expect(document.body.textContent).toContain(en['onboarding.index.retrying']);
  expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('3');
  fixture.fetch.mockResolvedValue(Response.json({ index: progress({ phase: 'ready', completed: 10,
    initializationRequired: false, indexCompletedAt: 300, updatedAt: 300 }) }));
  await tick();
  expect(document.querySelector('[data-content-index-onboarding]')).toBeNull();
  const calls = fixture.fetch.mock.calls.length;
  await tick(60_000);
  expect(fixture.fetch).toHaveBeenCalledTimes(calls);
});

test('continuing in background is local to this startup and runtime, never a server completion', async () => {
  await render();
  await tick(1);
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Continue in background');
  expect(button).toBeDefined();
  await act(async () => button?.click());
  await tick(300);
  expect(document.querySelector('[data-content-index-onboarding]')).toBeNull();
  const calls = fixture.fetch.mock.calls.length;
  await tick(6000);
  expect(fixture.fetch).toHaveBeenCalledTimes(calls);
  fixture.runtime = 'host-b';
  await render();
  await tick(1);
  expect(document.querySelector('[data-content-index-onboarding]')).not.toBeNull();
  expect(fixture.fetch.mock.calls.every(([url, options]) => url === '/api/openchamber/content-search' && !options.method)).toBe(true);
});

test('a previously complete Host is checked without flashing onboarding; VS Code never requests Host FTS', async () => {
  fixture.vscode = true;
  await render();
  expect(fixture.fetch).not.toHaveBeenCalled();
  fixture.vscode = false;
  fixture.fetch.mockImplementation(async () => Response.json({ index: progress({ phase: 'pending', initializationRequired: false }) }));
  await render();
  expect(document.querySelector('[data-content-index-onboarding]')).toBeNull();
  fixture.fetch.mockImplementation(async () => Response.json({ index: progress() }));
  await tick();
  await tick(1);
  expect(document.querySelector('[data-content-index-onboarding]')).not.toBeNull();
});
