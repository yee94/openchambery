import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  expect(host.querySelector('.yuri-image-loading')).toBeNull();
  await act(async () => second.dispatchEvent(new Event('load')));
  expect(host.querySelector('[data-image-state="loaded"]')).not.toBeNull();
});

test('a decoded cached image is immediately revealed without waiting for another load event', async () => {
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(320);
  await act(async () => root.render(<LoadingImage src="/cached.png" />));
  expect(host.querySelector('[data-image-state="loaded"]')).not.toBeNull();
});

test('desktop shows a constrained content placeholder and preserves image events', async () => {
  boundary.mobile = false;
  const onLoad = vi.fn();
  await act(async () => root.render(<LoadingImage src="/image.png" contentFrame onLoad={onLoad} />));
  expect(host.querySelector('[data-image-content="desktop"][data-image-state="loading"]')).not.toBeNull();
  expect(host.querySelector('.yuri-image-loading')).not.toBeNull();
  expect(host.querySelector('[data-image-content="mobile"]')).toBeNull();
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('load')));
  expect(onLoad).toHaveBeenCalledTimes(1);
  expect(host.querySelector('.yuri-image-loading')).toBeNull();
});

test('content frame keeps one CSS-owned height through every phase', async () => {
  // Height lives in image-loading.css (`--yuri-content-image-height`). No phase
  // may set inline geometry: a per-phase height lets late bytes move the reader.
  await act(async () => root.render(<LoadingImage src="/wide.png" contentFrame />));
  const frame = host.querySelector<HTMLElement>('[data-image-content]')!;
  expect(frame.getAttribute('style')).toBeNull();
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('load')));
  expect(host.querySelector<HTMLElement>('[data-image-content]')).toBe(frame);
  expect(frame.getAttribute('style')).toBeNull();
  await act(async () => root.render(<LoadingImage src="/missing.png" contentFrame />));
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(host.querySelector('[data-image-content][data-image-state="error"]')?.getAttribute('style')).toBeNull();
});

test('content images size inside the fixed frame instead of by intrinsic height', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'image-loading.css'), 'utf8');
  const frameRule = css.match(/\.yuri-image-frame\[data-image-content\] \{([^}]*)\}/)?.[1] ?? '';
  const imageRule = css.match(/\.yuri-image-frame\[data-image-content\] > img \{([^}]*)\}/)?.[1] ?? '';
  const legacyRule = css.match(/\[data-md-image-presentation='true'\] \{([^}]*)\}/)?.[1] ?? '';
  const legacyImageRule = css.match(/\[data-md-image-presentation='true'\] > img \{([^}]*)\}/)?.[1] ?? '';
  for (const rule of [frameRule, legacyRule]) {
    expect(rule).toContain('height: var(--yuri-content-image-height)');
    // A percentage width in a shrink-to-fit bubble collapses image-only bubbles.
    expect(rule).not.toMatch(/(?<!max-)width:\s*[^;]*%/);
  }
  for (const rule of [imageRule, legacyImageRule]) {
    expect(rule).toContain('height: 100%');
    expect(rule).toContain('object-fit: contain');
  }
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
