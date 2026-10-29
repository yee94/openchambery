import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GuiPluginLoadingNotice } from './GuiPluginLoadingNotice';

const state = vi.hoisted(() => ({ mobile: false, error: vi.fn() }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: state.mobile }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { error: state.error } }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.error.mockReset();
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const result = matchMedia(query);
    if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(result, 'matches', { value: true });
    return result;
  });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const draw = async (pending: boolean, runtime = 'a', error: string | null = null) => {
  await act(async () => root.render(<GuiPluginLoadingNotice key={runtime} pending={pending} error={error} inventory={[]} />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
};

it.each([false, true])('dismisses only the notice for the current runtime, and reports failures (mobile=%s)', async (mobile) => {
  state.mobile = mobile;
  await draw(true);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('guiPlugins.loadingNecessary');
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent === 'guiPlugins.continueBackground')!;
  expect(button).toBeDefined();
  await act(async () => button.click());
  await draw(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await draw(false); await draw(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await draw(false, 'a', 'offline');
  expect(state.error).toHaveBeenCalledExactlyOnceWith('guiPlugins.failed', { description: 'offline' });
  await draw(true, 'b');
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await draw(false, 'b');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('does not flash for a download that settles before the paint boundary', async () => {
  await act(async () => root.render(<GuiPluginLoadingNotice pending error={null} inventory={[]} />));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await draw(false);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
