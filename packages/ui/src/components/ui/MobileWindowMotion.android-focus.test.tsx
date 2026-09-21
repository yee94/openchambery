import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useNativeMobileChrome } from '@/apps/MobileApp';
import { I18nProvider } from '@/lib/i18n';
import { MobileModelPickerPanel } from '../model-picker/MobileModelPickerPanel';
import { mobileWindowStack } from './MobileWindowStack';

// MobileApp imports stores that initialize server state. Keep those unrelated
// requests inside the test while exercising the real native chrome hook.
vi.mock('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
}));

vi.mock('@capacitor/keyboard', () => ({ Keyboard: { setAccessoryBarVisible: async () => undefined } }));
vi.mock('@capacitor/status-bar', () => ({ StatusBar: {
  setOverlaysWebView: async () => undefined, setBackgroundColor: async () => undefined,
  setStyle: async () => undefined, show: async () => undefined,
}, Style: { Dark: 'DARK', Light: 'LIGHT' } }));
vi.mock('@capacitor/app', () => ({ App: { addListener: async () => ({ remove: async () => undefined }) } }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
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
  document.documentElement.classList.remove('oc-native-app-active');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Host({ initialFocus }: { initialFocus?: 'settings' | 'composer' }) {
  useNativeMobileChrome();
  const [open, setOpen] = React.useState(false);
  return <I18nProvider>
    <input data-testid="settings-field" autoFocus={initialFocus === 'settings'} />
    <div className="oc-mobile-composer">
      <textarea data-testid="composer-field" autoFocus={initialFocus === 'composer'} />
    </div>
    <button data-testid="model-trigger" onClick={() => setOpen(true)}>Choose model</button>
    <MobileModelPickerPanel open={open} onClose={() => setOpen(false)}
      selectedProviderID="" selectedModelID="" resolveSelectedVariant={() => undefined}
      onSelect={() => setOpen(false)} providers={[]} favoriteModels={[]} recentModels={[]}
      isFavorite={() => false} onToggleFavorite={() => undefined} />
  </I18nProvider>;
}

async function ime(open: boolean, payload: 'native' | 'detail') {
  await act(async () => {
    const data = { open, height: open ? 300 : 0 };
    // Native Bridge.triggerJSEvent copies payload fields directly onto Event.
    window.dispatchEvent(payload === 'native'
      ? Object.assign(new Event('oc:ime-state'), data)
      : new CustomEvent('oc:ime-state', { detail: data }));
  });
}

describe('Android native IME close during Settings picker focus transfer', () => {
  async function openPicker() {
    await act(async () => root.render(<Host />));
    const previous = document.querySelector<HTMLInputElement>('[data-testid="settings-field"]')!;
    await act(async () => previous.focus());
    expect(document.documentElement.style.getPropertyValue('--oc-keyboard-inset')).not.toBe('');
    await ime(true, 'native');
    await act(async () => {
      const trigger = document.querySelector<HTMLElement>('[data-testid="model-trigger"]')!;
      trigger.focus();
      trigger.click();
    });
    return document.querySelector<HTMLInputElement>('#mobile-overlay-root input')!;
  }

  test.each(['native', 'detail'] as const)('retains the new search focus when the previous IME close arrives (%s)', async (payload) => {
    const input = await openPicker();
    await act(async () => input.focus());
    expect(document.activeElement).toBe(input);
    const blur = vi.spyOn(input, 'blur');
    const surface = input.closest('[data-oc-motion-id]');
    const top = mobileWindowStack.getSnapshot();
    await ime(false, payload);
    expect(input.isConnected).toBe(true);
    expect(input.closest('[data-oc-motion-id]')).toBe(surface);
    expect(surface?.parentElement?.getAttribute('data-mobile-overlay-active')).toBe('true');
    expect(mobileWindowStack.getSnapshot()).toBe(top);
    expect(document.activeElement === input,
      `active=${document.activeElement?.tagName}; input.blur calls=${blur.mock.calls.length}; sheet and stack unchanged`,
    ).toBe(true);
    expect(blur).not.toHaveBeenCalled();
    expectClosedGeometry();
    // A repeated hide exercises markClosed's already-closed branch while the
    // same search field retains focus.
    await ime(false, payload);
    expect(document.activeElement === input).toBe(true);
    expect(blur).not.toHaveBeenCalled();
    expectClosedGeometry();
  });

  function expectClosedGeometry() {
    const html = document.documentElement;
    for (const name of ['--oc-keyboard-inset', '--oc-kb-layout', '--oc-kb-scroll-inset']) {
      expect(html.style.getPropertyValue(name)).toBe('0px');
    }
    expect(html.classList.contains('oc-keyboard-open')).toBe(false);
  }

  test.each(['settings', 'composer'] as const)('scopes a hide before the hook observed focus to its composer (%s)', async (initialFocus) => {
    // React autofocus occurs before the async native listener registration.
    await act(async () => root.render(<Host initialFocus={initialFocus} />));
    const field = document.querySelector<HTMLElement>(`[data-testid="${initialFocus}-field"]`)!;
    expect(document.activeElement === field).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--oc-keyboard-inset')).toBe('');
    const blur = vi.spyOn(field, 'blur');
    await ime(false, 'native');
    expect(document.activeElement === field).toBe(initialFocus === 'settings');
    expect(blur).toHaveBeenCalledTimes(initialFocus === 'composer' ? 1 : 0);
  });

  test('clears ordinary Settings field geometry while retaining DOM focus', async () => {
    await act(async () => root.render(<Host />));
    const input = document.querySelector<HTMLElement>('[data-testid="settings-field"]')!;
    await act(async () => input.focus());
    await ime(true, 'native');
    expect(document.documentElement.style.getPropertyValue('--oc-keyboard-inset')).toBe('300px');
    await ime(false, 'native');
    expect(document.activeElement === input).toBe(true);
    expectClosedGeometry();
  });

  test('native composer dismissal blurs once, clears geometry, and permits the next focus', async () => {
    await act(async () => root.render(<Host />));
    const composer = document.querySelector<HTMLElement>('[data-testid="composer-field"]')!;
    await act(async () => composer.focus());
    await ime(true, 'native');
    expect(document.documentElement.classList.contains('oc-keyboard-open')).toBe(true);
    const blur = vi.spyOn(composer, 'blur');
    await ime(false, 'native');
    expect(document.activeElement === document.body).toBe(true);
    expect(blur).toHaveBeenCalledTimes(1);
    expectClosedGeometry();
    await ime(false, 'native');
    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(blur).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('oc-kb-animating')).toBe(false);
    await act(async () => composer.focus());
    expect(document.activeElement === composer).toBe(true);
    expect(document.documentElement.classList.contains('oc-keyboard-open')).toBe(true);
  });

  test('retains search focus when native hide arrives before the new field focuses', async () => {
    const input = await openPicker();
    await ime(false, 'native');
    await act(async () => input.focus());
    await ime(true, 'native');
    expect(document.activeElement === input).toBe(true);
  });

  test('keeps input touch jitter uncancelled and focused without a native hide', async () => {
    const input = await openPicker();
    function touch(type: string, y: number) {
      const point = { identifier: 1, clientX: 10, clientY: y, target: input };
      const touches = Object.assign(type === 'touchend' ? [] : [point], {
        item: (index: number) => type === 'touchend' ? null : index === 0 ? point : null,
      });
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { touches, changedTouches: Object.assign([point], { item: () => point }) });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    await act(async () => {
      touch('touchstart', 10);
      touch('touchmove', 22);
      touch('touchend', 22);
      input.focus();
    });
    await ime(true, 'native');
    expect(document.activeElement === input).toBe(true);
  });
});
