import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import ToolOutputDialog from './ToolOutputDialog';
import { mobileBackNavigationCoordinator } from '@/mobile/mobileBackNavigation';
import type { ToolPopupContent } from './types';
import { mobileWindowStack } from '@/components/ui/MobileWindowStack';
import { saveImageToDevice } from '../imageSave';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ mermaidTheme }: { mermaidTheme?: { metadata: { variant: string } } }) => <svg viewBox="0 0 200 800" data-preview-theme={mermaidTheme?.metadata.variant} /> }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace' }));
const resourceRead = vi.hoisted(() => vi.fn((source: string) => ({ source, key: source })));
vi.mock('../imageSource', () => ({ useResolvedImageResource: resourceRead }));
vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => null }));
vi.mock('@/lib/shiki/appThemeRegistry', () => ({ ensurePierreThemeRegistered: () => {} }));
vi.mock('@/lib/native-ios-composer-leave', () => ({ concealNativeComposerIfLeavingChat: () => {} }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: () => null, DialogContent: () => null }));
vi.mock('./toolRenderers', () => ({}));
vi.mock('@/lib/toolHelpers', () => ({ getLanguageFromExtension: () => 'text' }));
vi.mock('./parts/VirtualizedCodeBlock', () => ({ VirtualizedCodeBlock: () => null }));
vi.mock('@/components/code/WorkerHighlightedCode', () => ({ WorkerHighlightedCode: () => null }));
vi.mock('../imageSave', () => ({ saveImageToDevice: vi.fn().mockResolvedValue('downloaded') }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
type SpringControl = { target: number; options: { velocity?: number }; stop: ReturnType<typeof vi.fn>; finish: () => void; fail: () => void };
const springs = vi.hoisted(() => ({ hold: false, started: [] as SpringControl[] }));
vi.mock('motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion')>();
  // Route Motion's render step through the spied rAF so tests flush frames deterministically.
  const scheduled = new Map<() => void, number>();
  const cancelFrame = (callback: () => void) => {
    const id = scheduled.get(callback);
    if (id !== undefined) cancelAnimationFrame(id);
    scheduled.delete(callback);
  };
  return {
    ...actual,
    cancelFrame,
    frame: { ...actual.frame, render: (callback: () => void) => {
      if (scheduled.has(callback)) return;
      scheduled.set(callback, requestAnimationFrame(() => { scheduled.delete(callback); callback(); }));
    } },
    animate: (value: import('motion').MotionValue<number>, target: number, options: { velocity?: number; onUpdate?: () => void }) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const finished = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      const control: SpringControl = {
        target, options, stop: vi.fn(),
        finish: () => { value.set(target); options.onUpdate?.(); resolve(); },
        fail: () => reject(new Error('cancelled')),
      };
      springs.started.push(control);
      if (!springs.hold) control.finish();
      return { finished, stop: control.stop };
    },
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement('div');
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.restoreAllMocks();
  springs.hold = false;
  springs.started.length = 0;
});

test('mobile image preview takes modal ownership from the underlying sheet and restores it on close', async () => {
  const sheetClose = vi.fn();
  const removeSheet = mobileWindowStack.add({ id: 'file-sheet', onClose: sheetClose }, document.body);
  root = createRoot(host);
  function Preview() {
    const [open, setOpen] = React.useState(true);
    return <ToolOutputDialog popup={{ open, title: 'Photo', content: '', image: { url: 'data:image/png;base64,AA==' } }} onOpenChange={setOpen} isMobile />;
  }
  try {
    await act(async () => root.render(<Preview />));
    expect(mobileWindowStack.getSnapshot()).not.toBe('file-sheet');
    await act(async () => mobileWindowStack.closeTop());
    expect(document.querySelector('[data-media-preview]')).toBeNull();
    expect(sheetClose).not.toHaveBeenCalled();
    expect(mobileWindowStack.getSnapshot()).toBe('file-sheet');
    expect(document.body.style.overflow).toBe('hidden');
  } finally { removeSheet(); }
});

test.each(['image', 'mermaid'] as const)('%s Back closes preview immediately and preserves the underlying route', async (kind) => {
  const close = vi.fn();
  const underlyingBack = vi.fn();
  const unregister = mobileBackNavigationCoordinator.register({ id: 'test-chat', layer: 'root', onBack: underlyingBack, getSurface: () => null, getUnderlay: () => null });
  root = createRoot(host);
  const popup = { open: true, title: 'Preview', content: '', [kind]: { url: 'data:text/plain,test', source: 'graph TD; A-->B' } } as ToolPopupContent;
  function Preview() {
    const [open, setOpen] = React.useState(true);
    return <ToolOutputDialog popup={{ ...popup, open }} onOpenChange={(next) => { close(next); setOpen(next); }} isMobile />;
  }
  try {
    await act(async () => root.render(<Preview />));
    await act(async () => { expect(mobileBackNavigationCoordinator.backImmediately('overlay')).toBe(true); });
    expect(close).toHaveBeenCalledWith(false);
    expect(underlyingBack).not.toHaveBeenCalled();
    expect(mobileBackNavigationCoordinator.getTopRoute()?.id).toBe('test-chat');
  } finally { unregister(); }
});

test('Mermaid preview occupies the full viewport rather than a square dialog', async () => {
  root = createRoot(host);
  await act(async () => root.render(<ToolOutputDialog popup={{ open: true, title: 'Diagram', content: '', mermaid: { url: 'data:text/plain,test', source: 'graph TD; A-->B' } }} onOpenChange={() => {}} isMobile />));
  const surface = document.querySelector('[data-mermaid-preview="true"]') as HTMLElement | null;
  expect(surface).not.toBeNull();
  expect(surface?.style.width).toBe('100%');
  expect(surface?.style.height).toBe('100%');
});

test.each(['image', 'mermaid'] as const)('%s has a visible close icon that dismisses the preview', async (kind) => {
  const close = vi.fn();
  root = createRoot(host);
  const popup = { open: true, title: 'Preview', content: '', [kind]: { url: 'data:text/plain,test', source: 'graph TD; A-->B' } } as ToolPopupContent;
  await act(async () => root.render(<ToolOutputDialog popup={popup} onOpenChange={close} isMobile />));
  const button = document.querySelector('[role="dialog"] button') as HTMLButtonElement;
  expect(button).not.toBeNull();
  expect(button.classList.contains('sr-only')).toBe(false);
  expect(button.querySelector('svg')).not.toBeNull();
  await act(async () => button.click());
  expect(close).toHaveBeenCalledWith(false);
});

test.each(['image', 'mermaid'] as const)('%s shares focus trapping, Escape and mobile black canvas', async (kind) => {
  const trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  const popup = { open: true, title: 'Preview', content: '', [kind]: { url: 'data:text/plain,test', source: 'graph TD; A-->B' } } as ToolPopupContent;
  function Preview() {
    const [open, setOpen] = React.useState(true);
    return <ToolOutputDialog popup={{ ...popup, open }} onOpenChange={setOpen} isMobile />;
  }
  root = createRoot(host);
  await act(async () => root.render(<Preview />));
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.querySelector<HTMLElement>('[data-media-preview-backdrop]')?.style.backgroundColor).toBe('var(--yuri-media-preview-background)');
  const buttons = dialog.querySelectorAll<HTMLButtonElement>('button');
  expect(document.activeElement).toBe(buttons[0]);
  await act(async () => buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

test('desktop preview preserves image aspect ratio within 80% width and 95% height', async () => {
  root = createRoot(host);
  await act(async () => root.render(<ToolOutputDialog popup={{ open: true, title: 'Photo', content: '', image: { url: 'data:image/png;base64,AA==' } }} onOpenChange={() => {}} isMobile={false} />));
  const image = document.querySelector('[data-preview-transition-target]') as HTMLImageElement;
  for (const [width, height] of [[2000, 1000], [1000, 3000]]) {
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: width }, naturalHeight: { configurable: true, value: height } });
    await act(async () => image.dispatchEvent(new Event('load')));
    const displayWidth = Number.parseFloat(image.style.width);
    const displayHeight = Number.parseFloat(image.style.height);
    expect(displayWidth).toBeLessThanOrEqual(window.innerWidth * 0.8 + 0.01);
    expect(displayHeight).toBeLessThanOrEqual(window.innerHeight * 0.95 + 0.01);
    expect(displayWidth / displayHeight).toBeCloseTo(width / height);
  }
});

test('desktop Mermaid uses an explicit dark rendering theme without a dark page theme', async () => {
  root = createRoot(host);
  await act(async () => root.render(<ToolOutputDialog popup={{ open: true, title: 'Diagram', content: '', mermaid: { url: 'data:text/plain,test', source: 'graph TD; A-->B' } }} onOpenChange={() => {}} isMobile={false} />));
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
  expect(dialog.querySelector('[data-preview-theme="dark"]')).not.toBeNull();
});

test('fullscreen image saves directly from its icon without a sheet or context-menu action', async () => {
  vi.mocked(saveImageToDevice).mockClear();
  root = createRoot(host);
  await act(async () => root.render(<ToolOutputDialog popup={{ open: true, title: 'Photo', content: '', image: { url: 'data:image/png;base64,AA==' } }} onOpenChange={() => {}} isMobile />));
  const image = document.querySelector('img')!;
  const previewOwner = mobileWindowStack.getSnapshot();
  await act(async () => image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  expect(saveImageToDevice).not.toHaveBeenCalled();
  const button = document.querySelector<HTMLButtonElement>('[data-media-save]')!;
  expect(button.textContent).toBe('');
  await act(async () => button.click());
  expect(saveImageToDevice).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: 'data:image/png;base64,AA==' }), expect.any(AbortSignal), expect.any(Function));
  expect(button.dataset.mediaSave).toBe('saved');
  expect(document.querySelector('[data-yuri-motion-id="image-save-actions-sheet"]')).toBeNull();
  expect(document.querySelector('[data-media-preview="image"]')).not.toBeNull();
  expect(mobileWindowStack.getSnapshot()).toBe(previewOwner);
  expect(document.querySelector('[data-media-preview="image"]')).not.toBeNull();
});

async function openGestureViewer(count = 4, isMobile = true) {
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++frameId, callback); return frameId; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  const gallery = Array.from({ length: count }, (_, index) => ({ url: `data:image/png;base64,${index}`, filename: `photo-${index}` }));
  const close = vi.fn();
  root = createRoot(host);
  await act(async () => root.render(<ToolOutputDialog popup={{ open: true, title: 'Photos', content: '', image: { ...gallery[0], gallery } }} onOpenChange={close} isMobile={isMobile} />));
  await act(async () => {
    for (const image of document.querySelectorAll<HTMLImageElement>('[data-image-viewer-slide] img')) {
      Object.defineProperties(image, { naturalWidth: { configurable: true, value: innerWidth }, naturalHeight: { configurable: true, value: innerHeight } });
      image.dispatchEvent(new Event('load'));
    }
  });
  now.mockReturnValue(1000);
  const canvas = document.querySelector<HTMLElement>('[data-image-viewer-canvas]')!;
  const captures = new Set<number>();
  canvas.setPointerCapture = (id) => { captures.add(id); };
  canvas.hasPointerCapture = (id) => captures.has(id);
  canvas.releasePointerCapture = (id) => { captures.delete(id); };
  let time = 1000;
  const pointer = async (type: string, x: number, y: number, id = 1, elapsed = 200) => {
    time += elapsed;
    await act(async () => {
      const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: isMobile ? 'touch' : 'mouse', clientX: x, clientY: y });
      Object.defineProperty(event, 'timeStamp', { value: time });
      canvas.dispatchEvent(event);
    });
  };
  const flush = async () => {
    await act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(time));
    });
  };
  return { canvas, close, pointer, flush, frames, captures,
    track: document.querySelector<HTMLElement>('[data-image-viewer-track]')!,
    dismiss: document.querySelector<HTMLElement>('[data-image-viewer-dismiss]')!,
    backdrop: document.querySelector<HTMLElement>('[data-media-preview-backdrop]')!,
  };
}

test('mobile gallery tracks the finger and promotes the same decoded neighbor element after swipe', async () => {
  const viewer = await openGestureViewer();
  const neighbor = document.querySelector<HTMLImageElement>('[data-image-viewer-slide="1"] img')!;
  await viewer.pointer('pointerdown', 300, 200);
  await viewer.pointer('pointermove', 100, 205);
  await viewer.flush();
  expect(viewer.track.style.transform).toBe('translate3d(-200px, 0, 0)');
  expect(document.querySelector('[data-media-gallery-counter]')?.textContent).toContain('1 / 4');
  await viewer.pointer('pointerup', 100, 205);
  expect(document.querySelector('[data-media-gallery-counter]')?.textContent).toContain('2 / 4');
  expect(document.querySelector('[data-preview-transition-target]')).toBe(neighbor);
  expect(viewer.track.style.transform).toBe('translate3d(0, 0, 0)');
  expect(viewer.captures.size).toBe(0);
  expect(viewer.close).not.toHaveBeenCalled();
});

test('a two-image gallery reuses one neighbor in either direction without duplicate image readers', async () => {
  const viewer = await openGestureViewer(2);
  const neighbor = document.querySelector<HTMLElement>('[data-image-viewer-slide="1"]')!;
  expect(document.querySelectorAll('[data-image-viewer-slide]')).toHaveLength(2);
  await viewer.pointer('pointerdown', 100, 200);
  await viewer.pointer('pointermove', 300, 200);
  await viewer.flush();
  expect(neighbor.style.transform).toBe(`translate3d(-${innerWidth + 16}px, 0, 0)`);
  await viewer.pointer('pointerup', 300, 200);
  expect(document.querySelector('[data-preview-transition-target]')).toBe(neighbor.querySelector('img'));
  expect(document.querySelector('[data-media-gallery-counter]')?.textContent).toContain('2 / 2');
});

test('downward drag shrinks and reveals the underlying page; short drag restores without closing', async () => {
  const viewer = await openGestureViewer(1);
  await viewer.pointer('pointerdown', 200, 200);
  await viewer.pointer('pointermove', 200, 250);
  await viewer.flush();
  expect(viewer.dismiss.style.transform).toContain('50px');
  expect(viewer.dismiss.style.transform).not.toContain('scale(1)');
  expect(Number(viewer.backdrop.style.opacity)).toBeLessThan(1);
  await viewer.pointer('pointerup', 200, 250);
  await viewer.flush();
  expect(viewer.dismiss.style.transform).toContain('scale(1)');
  expect(viewer.backdrop.style.opacity).toBe('1');
  expect(viewer.close).not.toHaveBeenCalled();
});

test('committed downward drag flushes the final geometry before invoking the existing close transition', async () => {
  const viewer = await openGestureViewer(1);
  await viewer.pointer('pointerdown', 200, 200);
  await viewer.pointer('pointermove', 205, 360);
  await viewer.pointer('pointerup', 205, 370);
  expect(viewer.dismiss.style.transform).toContain('170px');
  expect(viewer.close).toHaveBeenCalledWith(false);
  expect(viewer.captures.size).toBe(0);
  document.dispatchEvent(new MouseEvent('click', { clientX: 205, clientY: 370 }));
});

test('zoomed image pans first, then hands excess movement to gallery navigation', async () => {
  const viewer = await openGestureViewer();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="chat.toolOutputDialog.image.zoomInAria"]')!.click());
  await viewer.flush();
  await viewer.pointer('pointerdown', 300, 200);
  await viewer.pointer('pointermove', 200, 200);
  await viewer.flush();
  expect(viewer.track.style.transform).toBe('translate3d(0px, 0, 0)');
  expect(document.querySelector<HTMLElement>('[data-preview-transition-target]')?.style.transform).toContain('-100px');
  await viewer.pointer('pointermove', -200, 200);
  await viewer.flush();
  expect(viewer.track.style.transform).not.toBe('translate3d(0px, 0, 0)');
  await viewer.pointer('pointerup', -200, 200);
  expect(document.querySelector('[data-media-gallery-counter]')?.textContent).toContain('2 / 4');
});

test('zoomed image only enters pull-to-dismiss after consuming vertical pan and its handoff threshold', async () => {
  const viewer = await openGestureViewer(1);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="chat.toolOutputDialog.image.zoomInAria"]')!.click());
  await viewer.flush();
  await viewer.pointer('pointerdown', 200, 200);
  await viewer.pointer('pointermove', 200, 300);
  await viewer.flush();
  expect(viewer.backdrop.style.opacity).toBe('1');
  expect(viewer.dismiss.style.transform).toContain('scale(1)');
  await viewer.pointer('pointermove', 200, 600);
  await viewer.flush();
  expect(Number(viewer.backdrop.style.opacity)).toBeLessThan(1);
  await viewer.pointer('pointerup', 200, 600);
  expect(viewer.close).toHaveBeenCalledWith(false);
  document.dispatchEvent(new MouseEvent('click', { clientX: 200, clientY: 600 }));
});

test('cancelled gestures rebound, and pinch-to-one-finger continuation cannot dismiss or flip a page', async () => {
  const viewer = await openGestureViewer();
  await viewer.pointer('pointerdown', 200, 200);
  await viewer.pointer('pointermove', 200, 400);
  await viewer.pointer('pointercancel', 200, 400);
  await viewer.flush();
  expect(viewer.backdrop.style.opacity).toBe('1');
  await viewer.pointer('pointerdown', 100, 200);
  await viewer.pointer('pointerdown', 200, 200, 2);
  await viewer.pointer('pointermove', 300, 200, 2);
  await viewer.pointer('pointerup', 300, 200, 2);
  await viewer.pointer('pointermove', 100, 800);
  await viewer.pointer('pointerup', 100, 800);
  expect(viewer.close).not.toHaveBeenCalled();
  expect(document.querySelector('[data-media-gallery-counter]')?.textContent).toContain('1 / 4');
});

test('100 pointer moves coalesce into one frame without React image-resource work or gallery-wide mounting', async () => {
  const viewer = await openGestureViewer(1000);
  expect(document.querySelectorAll('[data-image-viewer-slide]')).toHaveLength(3);
  const resourceCalls = resourceRead.mock.calls.length;
  await viewer.pointer('pointerdown', 300, 200);
  for (let index = 1; index <= 100; index++) await viewer.pointer('pointermove', 300 - index, 200, 1, 8);
  expect(viewer.frames.size).toBe(1);
  expect(resourceRead.mock.calls.length).toBe(resourceCalls);
  await viewer.flush();
  expect(viewer.track.style.transform).toBe('translate3d(-100px, 0, 0)');
  await viewer.pointer('pointercancel', 200, 200);
});

test('desktop keeps empty-canvas click close and does not activate mobile drag-to-dismiss', async () => {
  const viewer = await openGestureViewer(1, false);
  await viewer.pointer('pointerdown', 200, 200);
  await viewer.pointer('pointermove', 200, 500);
  await viewer.pointer('pointerup', 200, 500);
  expect(viewer.close).not.toHaveBeenCalled();
  await viewer.pointer('pointerdown', 200, 200);
  await viewer.pointer('pointerup', 200, 200);
  expect(viewer.close).toHaveBeenCalledWith(false);
});

test('gallery springs the track out with finger momentum before committing the next index', async () => {
  const viewer = await openGestureViewer();
  springs.hold = true;
  const neighbor = document.querySelector('[data-image-viewer-slide="1"] img');
  await viewer.pointer('pointerdown', 300, 200);
  await viewer.pointer('pointermove', 200, 200, 1, 16);
  await viewer.pointer('pointermove', 100, 200, 1, 16);
  await viewer.pointer('pointerup', 100, 200, 1, 8);
  expect(document.querySelector('[data-media-gallery-counter]')?.textContent).toContain('1 / 4');
  expect(springs.started[0].target).toBe(-(innerWidth + 16));
  expect(springs.started[0].options.velocity).toBeLessThan(0);
  await act(async () => springs.started.forEach((spring) => spring.finish()));
  expect(document.querySelector('[data-media-gallery-counter]')?.textContent).toContain('2 / 4');
  expect(document.querySelector('[data-preview-transition-target]')).toBe(neighbor);
});

test('a touch during the release spring catches the track at its current offset instead of being ignored', async () => {
  const viewer = await openGestureViewer();
  springs.hold = true;
  await viewer.pointer('pointerdown', 300, 200);
  await viewer.pointer('pointermove', 260, 200);
  await viewer.pointer('pointerup', 260, 200);
  const rebound = springs.started[0];
  expect(rebound.target).toBe(0);
  await viewer.pointer('pointerdown', 150, 300);
  expect(rebound.stop).toHaveBeenCalled();
  await viewer.pointer('pointermove', 50, 300);
  await viewer.flush();
  expect(viewer.track.style.transform).toBe('translate3d(-140px, 0, 0)');
  springs.hold = false;
  await viewer.pointer('pointerup', 50, 300);
  expect(document.querySelector('[data-media-gallery-counter]')?.textContent).toContain('2 / 4');
  await act(async () => rebound.finish());
  expect(document.querySelector('[data-media-gallery-counter]')?.textContent).toContain('2 / 4');
  expect(viewer.close).not.toHaveBeenCalled();
});

test('a diagonal downward drag still enters pull-to-dismiss', async () => {
  const viewer = await openGestureViewer();
  await viewer.pointer('pointerdown', 200, 200);
  await viewer.pointer('pointermove', 260, 270);
  await viewer.flush();
  expect(viewer.track.style.transform).toBe('translate3d(0px, 0, 0)');
  expect(viewer.dismiss.style.transform).toContain('70px');
  expect(Number(viewer.backdrop.style.opacity)).toBeLessThan(1);
  await viewer.pointer('pointercancel', 260, 270);
});

test('a failed or unmounted settling spring cannot navigate late or leave the viewer locked', async () => {
  const viewer = await openGestureViewer();
  springs.hold = true;
  await viewer.pointer('pointerdown', 300, 200);
  await viewer.pointer('pointermove', 100, 200);
  await viewer.pointer('pointerup', 100, 200);
  await act(async () => springs.started[0].fail());
  await viewer.flush();
  expect(viewer.track.style.transform).toBe('translate3d(0px, 0, 0)');
  await viewer.pointer('pointerdown', 300, 200);
  await viewer.pointer('pointermove', 100, 200);
  await viewer.pointer('pointerup', 100, 200);
  expect(springs.started).toHaveLength(2);
  await act(async () => root.unmount());
  expect(springs.started[1].stop).toHaveBeenCalled();
  await act(async () => springs.started.forEach((spring) => spring.finish()));
  expect(viewer.close).not.toHaveBeenCalled();
});

test('resize cancels an in-flight dismissal and restores the backdrop', async () => {
  const viewer = await openGestureViewer();
  await viewer.pointer('pointerdown', 200, 200);
  await viewer.pointer('pointermove', 200, 300);
  await viewer.flush();
  expect(Number(viewer.backdrop.style.opacity)).toBeLessThan(1);
  const width = innerWidth;
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width - 100);
  await act(async () => window.dispatchEvent(new Event('resize')));
  expect(viewer.backdrop.style.opacity).toBe('1');
  await viewer.pointer('pointerup', 200, 500);
  expect(viewer.close).not.toHaveBeenCalled();
});

const waitDoubleTapWindow = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });

test('stationary mobile tap closes after the double-tap window and consumes the trailing native click', async () => {
  const viewer = await openGestureViewer(1);
  await viewer.pointer('pointerdown', 200, 200);
  await viewer.pointer('pointerup', 200, 200);
  expect(viewer.captures.size).toBe(0);
  expect(viewer.close).not.toHaveBeenCalled();
  await waitDoubleTapWindow();
  expect(viewer.close).toHaveBeenCalledTimes(1);
  const click = new MouseEvent('click', { clientX: 200, clientY: 200, cancelable: true, bubbles: true });
  document.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
});

test('mobile double tap zooms around the tapped point, and a second double tap restores without closing', async () => {
  const viewer = await openGestureViewer(1);
  const image = document.querySelector<HTMLElement>('[data-preview-transition-target]')!;
  const center = { x: innerWidth / 2, y: innerHeight / 2 };
  await viewer.pointer('pointerdown', center.x - 100, center.y - 50);
  await viewer.pointer('pointerup', center.x - 100, center.y - 50, 1, 60);
  await viewer.pointer('pointerdown', center.x - 96, center.y - 48, 1, 120);
  await viewer.pointer('pointerup', center.x - 96, center.y - 48, 1, 60);
  await viewer.flush();
  expect(image.style.transform).toBe('translate3d(96px, 48px, 0) scale(2)');
  expect(image.style.transition).toContain('transform');
  await waitDoubleTapWindow();
  expect(viewer.close).not.toHaveBeenCalled();
  await viewer.pointer('pointerdown', center.x, center.y);
  await viewer.pointer('pointerup', center.x, center.y, 1, 60);
  await viewer.pointer('pointerdown', center.x, center.y, 1, 120);
  await viewer.pointer('pointerup', center.x, center.y, 1, 60);
  await viewer.flush();
  expect(image.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
  await waitDoubleTapWindow();
  expect(viewer.close).not.toHaveBeenCalled();
});

test('a slow or distant second tap does not zoom', async () => {
  const viewer = await openGestureViewer(1);
  const image = document.querySelector<HTMLElement>('[data-preview-transition-target]')!;
  await viewer.pointer('pointerdown', 100, 100);
  await viewer.pointer('pointerup', 100, 100, 1, 60);
  await viewer.pointer('pointerdown', 260, 300, 1, 100);
  await viewer.pointer('pointerup', 260, 300, 1, 60);
  await viewer.flush();
  expect(image.style.transform).not.toContain('scale(2)');
  await waitDoubleTapWindow();
  expect(viewer.close).toHaveBeenCalledTimes(1);
});

test('one failed slide does not prevent navigating to an already decoded neighbor', async () => {
  const viewer = await openGestureViewer();
  const neighbor = document.querySelector('[data-image-viewer-slide="1"] img');
  await act(async () => document.querySelector('[data-preview-transition-target]')!.dispatchEvent(new Event('error')));
  expect(document.querySelector('[data-image-viewer-slide="0"] [role="status"]')?.textContent).toBe('filesView.error.readFileFailed');
  await viewer.pointer('pointerdown', 300, 200);
  await viewer.pointer('pointermove', 100, 200);
  await viewer.pointer('pointerup', 100, 200);
  expect(document.querySelector('[data-preview-transition-target]')).toBe(neighbor);
  expect(document.querySelector('[data-media-gallery-counter]')?.textContent).toContain('2 / 4');
});

test('zoom controls cancel a settling swipe instead of allowing its stale completion to change images', async () => {
  const viewer = await openGestureViewer();
  springs.hold = true;
  await viewer.pointer('pointerdown', 300, 200);
  await viewer.pointer('pointermove', 100, 200);
  await viewer.pointer('pointerup', 100, 200);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="chat.toolOutputDialog.image.zoomInAria"]')!.click());
  await viewer.flush();
  await act(async () => springs.started.forEach((spring) => spring.finish()));
  expect(document.querySelector('[data-media-gallery-counter]')?.textContent).toContain('1 / 4');
  expect(document.querySelector<HTMLElement>('[data-preview-transition-target]')?.style.transform).toContain('scale(1.4)');
  expect(springs.started[0].stop).toHaveBeenCalled();
});
