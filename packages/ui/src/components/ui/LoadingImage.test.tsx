import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LoadingImage } from './LoadingImage';

const boundary = vi.hoisted(() => ({ mobile: true, reads: vi.fn() }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: { isMobile: boolean }) => unknown) => {
  boundary.reads();
  return select({ isMobile: boundary.mobile });
} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  boundary.mobile = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks();
});

test('changing the source hides the old image and ignores late events from it', async () => {
  await act(async () => root.render(<LoadingImage src="/first.png" alt="photo" />));
  const first = host.querySelector('img')!;
  await act(async () => first.dispatchEvent(new Event('load')));
  expect(host.querySelector('[data-image-state="loaded"]')).not.toBeNull();
  await act(async () => root.render(<LoadingImage src="/second.png" alt="photo" />));
  await act(async () => first.dispatchEvent(new Event('load')));
  expect(host.querySelector('[data-image-state="loading"]')).not.toBeNull();
  const second = host.querySelector('img')!;
  expect(second.style.opacity).toBe('0');
  await act(async () => second.dispatchEvent(new Event('error')));
  expect(host.querySelector('[data-image-state="error"]')).not.toBeNull();
  expect(host.querySelector('.oc-image-loading')).toBeNull();
  await act(async () => second.dispatchEvent(new Event('load')));
  expect(host.querySelector('[data-image-state="loaded"]')).not.toBeNull();
});

test('a decoded cached image is immediately revealed without waiting for another load event', async () => {
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(320);
  await act(async () => root.render(<LoadingImage src="/cached.png" />));
  expect(host.querySelector('[data-image-state="loaded"]')).not.toBeNull();
});

test('desktop keeps the image DOM and native event handlers', async () => {
  boundary.mobile = false;
  const onLoad = vi.fn();
  await act(async () => root.render(<LoadingImage src="/image.png" onLoad={onLoad} />));
  expect(host.firstElementChild?.tagName).toBe('IMG');
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('load')));
  expect(onLoad).toHaveBeenCalledTimes(1);
});

test('content reserves the requested ratio only while pending and resets on source change', async () => {
  await act(async () => root.render(<LoadingImage src="/wide.png" placeholderAspectRatio={16 / 9} />));
  const frame = host.querySelector<HTMLElement>('[data-image-content]')!;
  expect(parseFloat(frame.style.aspectRatio)).toBeCloseTo(16 / 9);
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('load')));
  expect(frame.style.aspectRatio).toBe('');
  await act(async () => root.render(<LoadingImage src="/portrait.png" placeholderAspectRatio={3 / 4} />));
  expect(parseFloat(host.querySelector<HTMLElement>('[data-image-content]')!.style.aspectRatio)).toBe(0.75);
});

test('thumbnail fill never adopts the content placeholder sizing', async () => {
  await act(async () => root.render(<LoadingImage fill src="/thumb.png" />));
  expect(host.querySelector('[data-image-fill]')).not.toBeNull();
  expect(host.querySelector('[data-image-content]')).toBeNull();
});

test('50 unrelated composer renders perform no image hook work or image remounts', async () => {
  function Composer({ draft }: { draft: string }) {
    return <div><input value={draft} readOnly /><LoadingImage fill src="/attachment.png" alt="attachment" className="size-16" /></div>;
  }
  await act(async () => root.render(<Composer draft="" />));
  const image = host.querySelector('img');
  boundary.reads.mockClear();
  for (let index = 0; index < 50; index++) await act(async () => root.render(<Composer draft={`draft ${index}`} />));
  expect(boundary.reads).not.toHaveBeenCalled();
  expect(host.querySelector('img')).toBe(image);
});
