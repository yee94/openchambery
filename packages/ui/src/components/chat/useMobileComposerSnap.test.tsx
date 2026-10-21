import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMobileComposerSnap } from './useMobileComposerSnap';
import { useComposerTextareaAutosize } from './useComposerTextareaAutosize';
import { useMobileSheetSnap } from '../ui/useMobileSheetSnap';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let result: ReturnType<typeof useMobileComposerSnap>;
let contentHeight = 120;

function Probe({ text = 'draft', draftID = 'one', enabled = true }: { text?: string; draftID?: string; enabled?: boolean }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  result = useMobileComposerSnap({ enabled, hasContent: text.length > 0, draftID, inputRef });
  useComposerTextareaAutosize({ inputRef, message: text, expanded: false, isMobile: true, dictationHeight: null, manualHeight: result.manualHeight });
  return <section>
    <header className="oc-mobile-detail-navigation" />
    <div data-mobile-composer-surface>
      <div data-handle onPointerDown={result.handlePointerDown} onPointerMove={result.handlePointerMove}
        onPointerUp={result.handlePointerUp} onPointerCancel={result.handlePointerCancel} />
      <textarea ref={inputRef} defaultValue={text} style={{ lineHeight: '20px', padding: '10px', minHeight: '40px' }} />
    </div>
  </section>;
}

beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  contentHeight = 120;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.tagName === 'HEADER' ? 64 : this.tagName === 'TEXTAREA' ? parseFloat(this.style.height) || 120 : 160;
    const bottom = this.tagName === 'HEADER' ? 64 : this.tagName === 'TEXTAREA' ? 740 : 780;
    return { x: 0, y: bottom - height, top: bottom - height, bottom, left: 0, right: 390, width: 390, height, toJSON() {} };
  });
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight);
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it('keeps manual heights during edits, returns to natural sizing, and resets on clear or draft switch', async () => {
  await act(async () => root.render(<Probe />));
  const input = host.querySelector('textarea')!;
  input.focus(); input.setSelectionRange(2, 2);
  await act(async () => result.settleAt('min'));
  expect(input.style.height).toBe('40px');
  const measure = vi.spyOn(window, 'getComputedStyle'); measure.mockClear();
  for (let i = 0; i < 50; i++) await act(async () => root.render(<Probe text={`draft ${i}`} />));
  expect(measure).not.toHaveBeenCalled();
  expect(input.style.height).toBe('40px');
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(2);
  contentHeight = 160;
  await act(async () => result.settleAt('auto'));
  expect(input.style.height).toBe('160px');
  await act(async () => result.settleAt('full'));
  expect(result.snapPoint).toBe('full');
  expect(parseFloat(input.style.height)).toBeGreaterThan(160);
  await act(async () => root.render(<Probe draftID="two" />));
  expect(result.snapPoint).toBe('auto');
  await act(async () => result.settleAt('min'));
  await act(async () => root.render(<Probe text="" draftID="two" />));
  expect(result.visible).toBe(false);
  expect(result.snapPoint).toBe('auto');
});

it('cancels pointer ownership and restores the starting snap without remounting the input', async () => {
  await act(async () => root.render(<Probe />));
  const handle = host.querySelector<HTMLElement>('[data-handle]')!;
  handle.setPointerCapture = vi.fn(); handle.hasPointerCapture = () => true; handle.releasePointerCapture = vi.fn();
  const input = host.querySelector('textarea')!;
  const event = (type: string, y: number) => new PointerEvent(type, { bubbles: true, pointerId: 1, isPrimary: true, clientY: y });
  await act(async () => handle.dispatchEvent(event('pointerdown', 600)));
  expect(result.dragging).toBe(true);
  await act(async () => handle.dispatchEvent(event('pointermove', 100)));
  await act(async () => handle.dispatchEvent(event('pointercancel', 100)));
  expect(result.snapPoint).toBe('auto');
  expect(result.dragging).toBe(false);
  expect(host.querySelector('textarea')).toBe(input);
  expect(input.style.height).toBe('120px');
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
});

it('keeps the feature disabled on excluded surfaces', async () => {
  await act(async () => root.render(<Probe enabled={false} />));
  expect(result.visible).toBe(false);
  expect(result.manualHeight).toBe(false);
});

it('keeps autosize suspended until settlement finishes so animated scrollHeight cannot become the resting height', async () => {
  await act(async () => root.render(<Probe />));
  const input = host.querySelector('textarea')!;
  await act(async () => result.settleAt('full'));
  vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
  let finish!: () => void;
  let animating = false;
  Object.defineProperty(input, 'animate', { configurable: true, value: vi.fn(() => {
    animating = true;
    const native = { onfinish: null as (() => void) | null, currentTime: 0,
      cancel: () => { animating = false; } };
    finish = () => native.onfinish?.();
    return native;
  }) });
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => animating ? 370 : contentHeight);
  await act(async () => result.settleAt('auto', 370));
  expect(result.manualHeight).toBe(true);
  expect(input.style.height).toBe('120px');
  // Retarget before completion: natural measurement must not see the old animation.
  await act(async () => result.settleAt('auto', 240));
  expect(result.manualHeight).toBe(true);
  expect(input.style.height).toBe('120px');
  await act(async () => finish());
  expect(result.manualHeight).toBe(false);
  expect(input.style.height).toBe('120px');
});

it('retains content-sized sheet expansion, collapse and downward dismissal through the shared gesture', async () => {
  const dismiss = vi.fn();
  let sheet!: ReturnType<typeof useMobileSheetSnap>;
  function SheetProbe() {
    sheet = useMobileSheetSnap({ fitContent: true, onDismiss: dismiss });
    return <div ref={sheet.surfaceRef}><div data-handle onPointerDown={sheet.handlePointerDown}
      onPointerMove={sheet.handlePointerMove} onPointerUp={sheet.handlePointerUp} /></div>;
  }
  await act(async () => root.render(<SheetProbe />));
  await act(async () => sheet.handleClick());
  expect(sheet.snapPoint).toBe(0.98);
  await act(async () => sheet.handleClick());
  expect(sheet.snapPoint).toBe(0.72);
  const handle = host.querySelector<HTMLElement>('[data-handle]')!;
  handle.setPointerCapture = vi.fn(); handle.hasPointerCapture = () => true; handle.releasePointerCapture = vi.fn();
  const event = (type: string, y: number) => new PointerEvent(type, { bubbles: true, pointerId: 2, isPrimary: true, clientY: y });
  await act(async () => handle.dispatchEvent(event('pointerdown', 600)));
  const canvas = sheet.surfaceRef.current!;
  const frozenHeight = canvas.style.height;
  const initialTranslate = canvas.style.translate;
  expect(canvas.style.position).toBe('absolute');
  expect(canvas.style.bottom).toBe('0px');
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect'); measure.mockClear();
  for (let i = 0; i < 50; i++) await act(async () => handle.dispatchEvent(event('pointermove', 601 + i * 2)));
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(measure).not.toHaveBeenCalled();
  expect(canvas.style.height).toBe(frozenHeight);
  expect(canvas.style.translate).not.toBe(initialTranslate);
  await act(async () => handle.dispatchEvent(event('pointerup', 700)));
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(sheet.dragging).toBe(false);
  await act(async () => sheet.reset());
  expect(canvas.style.position).toBe('');
  expect(canvas.style.translate).toBe('');
  expect(canvas.style.height).toBe('');
});

it.each(['clear', 'draft switch', 'unmount'])('cancels an in-flight Motion settlement on %s', async (change) => {
  await act(async () => root.render(<Probe />));
  const input = host.querySelector('textarea')!;
  const cancel = vi.fn();
  Object.defineProperty(input, 'animate', { configurable: true, value: () => ({ cancel, currentTime: 0 }) });
  vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
  await act(async () => result.settleAt('full'));
  expect(result.manualHeight).toBe(true);
  await act(async () => root.render(change === 'unmount' ? null
    : <Probe text={change === 'clear' ? '' : 'draft'} draftID={change === 'draft switch' ? 'two' : 'one'} />));
  expect(cancel).toHaveBeenCalledOnce();
  expect(input.hasAttribute('data-height-snap-active')).toBe(false);
  if (change !== 'unmount') {
    expect(result.manualHeight).toBe(false);
    expect(result.snapPoint).toBe('auto');
  }
});

it('settles a sheet using independent translate and restores its canvas after Motion completes', async () => {
  let sheet!: ReturnType<typeof useMobileSheetSnap>;
  function SheetProbe() {
    sheet = useMobileSheetSnap({ fitContent: true });
    return <div ref={sheet.surfaceRef} style={{ transform: 'translateY(7px)' }} />;
  }
  await act(async () => root.render(<SheetProbe />));
  const canvas = sheet.surfaceRef.current!;
  const native = { onfinish: null as (() => void) | null, currentTime: 0, cancel: vi.fn() };
  const animate = vi.fn<(keyframes: PropertyIndexedKeyframes) => typeof native>(() => native);
  Object.defineProperty(canvas, 'animate', { configurable: true, value: animate });
  vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
  await act(async () => sheet.handleClick());
  expect(canvas.style.position).toBe('absolute');
  expect(canvas.style.transform).toBe('translateY(7px)');
  expect(animate.mock.calls[0]?.[0]).toHaveProperty('translate');
  await act(async () => native.onfinish?.());
  expect(canvas.style.position).toBe('');
  expect(canvas.style.translate).toBe('');
  expect(canvas.style.height).toBe('');
  expect(canvas.style.transform).toBe('translateY(7px)');
});
