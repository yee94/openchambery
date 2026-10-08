import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({ conceal: vi.fn(), reveal: vi.fn() }));
vi.mock('@/lib/native-ios-composer-session', () => ({ nativeIosComposerSession: native }));
vi.mock('@/components/ui/CommandPalette', () => ({
  CommandPalette: ({ presentation, onBack }: { presentation: string; onBack: () => void }) => (
    <section data-presentation={presentation}><input aria-label="Search" /><button onClick={onBack}>Back</button></section>
  ),
}));

import { MobileGlobalSearchHost } from './MobileGlobalSearchHost';
import { mobileBackNavigationCoordinator } from './mobileBackNavigation';
import { useUIStore } from '@/stores/useUIStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('mobile global search push page', () => {
  let root: Root | undefined;
  let host: HTMLDivElement;
  afterEach(() => {
    act(() => { root?.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    host?.remove();
    vi.clearAllMocks();
  });

  test.each(['header', 'system'] as const)('%s Back restores the mounted origin and unregisters search', async (back) => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(
      <MobileGlobalSearchHost>
        <input data-draft defaultValue="draft" />
        <button data-search onClick={() => useUIStore.getState().setCommandPaletteOpen(true)}>Search</button>
      </MobileGlobalSearchHost>,
    ));
    const draft = host.querySelector<HTMLInputElement>('[data-draft]')!;
    draft.value = 'preserved draft';
    const trigger = host.querySelector<HTMLButtonElement>('[data-search]')!;
    trigger.focus();
    await act(async () => trigger.click());
    const page = host.querySelector<HTMLElement>('[data-mobile-search-page]')!;
    expect(page).not.toBeNull();
    expect(page.querySelector('[data-presentation="page"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    const route = mobileBackNavigationCoordinator.getTopRoute()!;
    expect(route.id).toBe('mobile-global-search');
    expect(route.getSurface()).toBe(page);
    expect(route.getUnderlay()?.contains(draft)).toBe(true);
    expect(route.getUnderlay()?.hasAttribute('inert')).toBe(true);
    expect(native.conceal).toHaveBeenCalledOnce();

    await act(async () => {
      if (back === 'header') page.querySelector<HTMLButtonElement>('button')!.click();
      else expect(mobileBackNavigationCoordinator.backImmediately('root')).toBe(true);
    });
    expect(host.querySelector('[data-mobile-search-page]')).toBeNull();
    expect(host.querySelector('[data-draft]')).toBe(draft);
    expect(draft.value).toBe('preserved draft');
    expect(document.activeElement).toBe(trigger);
    expect(mobileBackNavigationCoordinator.getTopRoute()).toBeNull();
    expect(native.reveal).toHaveBeenCalledOnce();
  });
});
