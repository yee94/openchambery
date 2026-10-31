import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Dialog } from '@base-ui/react/dialog';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MobileModelPickerPanel } from '../model-picker/MobileModelPickerPanel';
import { MobileResizableSheet } from './MobileResizableSheet';
import { I18nProvider } from '@/lib/i18n';
import { preventComposerActionPointerFocus } from '../chat/composerFocus';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
    removeEventListener: vi.fn(), dispatchEvent: () => true,
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.getElementById('mobile-overlay-root')?.remove();
  vi.restoreAllMocks();
});

function Picker() {
  const [open, setOpen] = React.useState(false);
  return <>
    <button data-testid="model-trigger" onClick={() => setOpen(true)}>Choose model</button>
    <MobileModelPickerPanel open={open} onClose={() => setOpen(false)}
      selectedProviderID="" selectedModelID="" resolveSelectedVariant={() => undefined}
      onSelect={() => setOpen(false)} providers={[]} favoriteModels={[]} recentModels={[]}
      isFavorite={() => false} onToggleFavorite={() => undefined} />
  </>;
}

function Host({ kind, modal = true }: { kind: 'page' | 'sheet' | 'dialog' | 'composer'; modal?: boolean }) {
    const [open, setOpen] = React.useState(true);
    // happy-dom proxies form elements with a different identity from parentNode;
    // use a DOM host with working contains() for the shared production capture.
    if (kind === 'composer') return <div onPointerDownCapture={(event) => preventComposerActionPointerFocus(event, () => undefined)}>
      <textarea data-chat-input="true" /><Picker />
    </div>;
  if (kind === 'page') return <Picker />;
  if (kind === 'sheet') return <MobileResizableSheet id="settings" open={open} onOpenChange={setOpen}
    ariaLabel="Settings" closeAriaLabel="Close settings" resizeAriaLabel="Resize settings"><Picker /></MobileResizableSheet>;
  return <Dialog.Root open={open} onOpenChange={setOpen} modal={modal}>
    <Dialog.Portal><Dialog.Backdrop /><Dialog.Popup aria-label="Settings"><Picker /></Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}

async function tap(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    element.focus();
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    element.click();
  });
}

describe('mobile model picker focus through Settings hosts', () => {
  test('keeps initial focus outside interactive descendants without focusing a field or resize handle', async () => {
    await act(async () => root.render(<MobileResizableSheet id="export-menu" open onOpenChange={() => undefined}
      ariaLabel="File preview" closeAriaLabel="Close" resizeAriaLabel="Resize">
      <details open><summary>Export</summary><button>Export PDF</button></details>
      <input />
    </MobileResizableSheet>));
    const surface = document.querySelector<HTMLElement>('[data-yuri-motion-id="export-menu"]')!;
    const button = surface.querySelector('button:not([data-mobile-sheet-snap-handle])')!;
    // iOS retargets taps on details descendants to a tabindex-bearing ancestor.
    expect(button.closest('[tabindex]')).toBeNull();
    const initial = document.activeElement as HTMLElement;
    expect(surface.contains(initial)).toBe(true);
    expect(initial.tabIndex).toBe(-1);
    expect(initial.contains(button)).toBe(false);
    expect(initial.matches('input, [data-mobile-sheet-snap-handle]')).toBe(false);
  });

  test('composer capture permits native focus in a portaled picker while guarding its own toolbar', async () => {
    await act(async () => root.render(<I18nProvider><Host kind="composer" /></I18nProvider>));
    const trigger = document.querySelector<HTMLElement>('[data-testid="model-trigger"]')!;
    const toolbarPress = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' });
    await act(async () => trigger.dispatchEvent(toolbarPress));
    expect(toolbarPress.defaultPrevented).toBe(true);
    await act(async () => trigger.click());
    const input = document.querySelector<HTMLInputElement>('#mobile-overlay-root input')!;
    const searchPress = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' });
    await act(async () => input.dispatchEvent(searchPress));
    expect(searchPress.defaultPrevented).toBe(false);
    await act(async () => input.focus());
    expect(document.activeElement).toBe(input);
  });

  test.each(['page', 'sheet', 'dialog', 'composer'] as const)('does not move the IME surface before native touch focus in %s', async (kind) => {
    await act(async () => root.render(<I18nProvider><Host kind={kind} /></I18nProvider>));
    await tap(document.querySelector<HTMLElement>('[data-testid="model-trigger"]')!);
    const input = document.querySelector<HTMLInputElement>('#mobile-overlay-root input')!;
    // Touch focus is a mousedown default action, after pointerup. Moving the
    // keyboard-inset sheet sooner retargets that mousedown and blurs the input.
    await act(async () => {
      input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    });
    expect(document.activeElement).not.toBe(input);
    await act(async () => {
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      input.focus();
      input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      input.click();
    });
    expect(document.activeElement).toBe(input);
  });

  test.each(['page', 'sheet', 'dialog', 'composer'] as const)('keeps tapped search focused in %s', async (kind) => {
    await act(async () => root.render(<I18nProvider><Host kind={kind} /></I18nProvider>));
    await tap(document.querySelector<HTMLElement>('[data-testid="model-trigger"]')!);
    const input = document.querySelector<HTMLInputElement>('#mobile-overlay-root input')!;
    expect(input).toBeTruthy();
    await tap(input);
    expect(document.activeElement).toBe(input);
  });
});
