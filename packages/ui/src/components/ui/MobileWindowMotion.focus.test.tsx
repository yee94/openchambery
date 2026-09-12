import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Dialog } from '@base-ui/react/dialog';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MobileModelPickerPanel } from '../model-picker/MobileModelPickerPanel';
import { MobileResizableSheet } from './MobileResizableSheet';
import { I18nProvider } from '@/lib/i18n';

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

function Host({ kind, modal = true }: { kind: 'page' | 'sheet' | 'dialog'; modal?: boolean }) {
  const [open, setOpen] = React.useState(true);
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
  test.each(['page', 'sheet', 'dialog'] as const)('keeps tapped search focused in %s', async (kind) => {
    await act(async () => root.render(<I18nProvider><Host kind={kind} /></I18nProvider>));
    await tap(document.querySelector<HTMLElement>('[data-testid="model-trigger"]')!);
    const input = document.querySelector<HTMLInputElement>('#mobile-overlay-root input')!;
    expect(input).toBeTruthy();
    await tap(input);
    expect(document.activeElement).toBe(input);
  });
});
