import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MediaSaveButton } from './MediaSaveButton';
import { saveImageToDevice } from '../imageSave';

vi.mock('../imageSave', () => ({ saveImageToDevice: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.mocked(saveImageToDevice).mockReset(); host = document.createElement('div'); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); });
const render = (sourceUrl = 'blob:first') => act(async () => root.render(<MediaSaveButton isMobile key={sourceUrl} target={{ sourceUrl }} />));
const button = () => host.querySelector('button')!;

test('one click shows an icon-only spinner until saving completes, then a check without duplicate writes', async () => {
  let finish!: (result: 'saved') => void;
  vi.mocked(saveImageToDevice).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render();
  await act(async () => { button().click(); button().click(); });
  expect(saveImageToDevice).toHaveBeenCalledTimes(1);
  expect(button().dataset.mediaSave).toBe('saving');
  expect(button().getAttribute('aria-busy')).toBe('true');
  expect(button().querySelector('svg')?.classList.contains('motion-safe:animate-spin')).toBe(true);
  expect(button().textContent).toBe('');
  await act(async () => finish('saved'));
  expect(button().dataset.mediaSave).toBe('saved');
  expect(button().querySelector('use')?.getAttribute('href')).toContain('check');
  await act(async () => button().click());
  expect(saveImageToDevice).toHaveBeenCalledTimes(1);
});

test('a failed save resets to a retryable download icon, never success', async () => {
  vi.mocked(saveImageToDevice).mockRejectedValueOnce(new Error('Photo library permission denied')).mockResolvedValueOnce('saved');
  await render();
  await act(async () => button().click());
  expect(button().dataset.mediaSave).toBe('error');
  expect(button().disabled).toBe(false);
  expect(button().querySelector('use')?.getAttribute('href')).toContain('download');
  await act(async () => button().click());
  expect(button().dataset.mediaSave).toBe('saved');
});

test('switching media aborts the old read and ignores its late completion', async () => {
  let finish!: (result: 'saved') => void;
  vi.mocked(saveImageToDevice).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render();
  await act(async () => button().click());
  const signal = vi.mocked(saveImageToDevice).mock.calls[0][1]!;
  await render('blob:second');
  expect(signal.aborted).toBe(true);
  await act(async () => finish('saved'));
  expect(button().dataset.mediaSave).toBe('idle');
});

test('native picker cancellation returns to idle without a success check', async () => {
  vi.mocked(saveImageToDevice).mockRejectedValue(new DOMException('Save cancelled', 'AbortError'));
  await render();
  await act(async () => button().click());
  expect(button().dataset.mediaSave).toBe('idle');
});
