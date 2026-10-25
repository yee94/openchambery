import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createJSONStorage } from 'zustand/middleware';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSidebarBrandStore } from '@/stores/useSidebarBrandStore';
import { loadBrandDisplayFont } from '@/lib/fontLoader';
import { SidebarBrandMark } from './SidebarBrandMark';

vi.mock('@/lib/fontLoader', () => ({ loadBrandDisplayFont: vi.fn(async () => {}) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalStorage = useSidebarBrandStore.persist.getOptions().storage;
const saved = new Map<string, string>();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  saved.clear();
  vi.mocked(loadBrandDisplayFont).mockClear();
  useSidebarBrandStore.persist.setOptions({
    storage: createJSONStorage(() => ({
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => { saved.set(key, value); },
      removeItem: (key) => { saved.delete(key); },
    })),
  });
  useSidebarBrandStore.setState({ sidebarBrandName: 'Yuri' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useSidebarBrandStore.persist.setOptions({ storage: originalStorage });
});

describe('sidebar brand selection and persisted defaults', () => {
  it('uses the SVG for Yuri and switches live to custom typography or a hidden slot', () => {
    act(() => root.render(<SidebarBrandMark />));
    const mark = container.querySelector('[role="img"]');
    expect(mark?.getAttribute('aria-label')).toBe('Yuri');
    expect(mark?.getAttribute('style')).toContain('mask');
    expect(mark?.classList.contains('text-foreground')).toBe(true);
    expect(loadBrandDisplayFont).not.toHaveBeenCalled();

    act(() => useSidebarBrandStore.getState().setSidebarBrandName('My Studio'));
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.querySelector('.text-foreground')?.textContent).toBe('My');
    expect(container.querySelector('.text-primary')?.textContent).toBe('Studio');
    expect(loadBrandDisplayFont).toHaveBeenCalledOnce();

    act(() => useSidebarBrandStore.getState().setSidebarBrandName(' Yuri '));
    expect(container.querySelector('[role="img"]')).not.toBeNull();
    act(() => useSidebarBrandStore.getState().setSidebarBrandName('  '));
    expect(container.innerHTML).toBe('');
  });

  it.each(['Yuri Studio', 'yuri', 'YURI'])('keeps %s as custom text instead of a partial or case-insensitive match', (name) => {
    act(() => {
      useSidebarBrandStore.getState().setSidebarBrandName(name);
      root.render(<SidebarBrandMark />);
    });
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(name);
  });

  it.each([
    [0, 'YEE CODE', 'Yuri'],
    [1, 'Open Chamber', 'Yuri'],
    [2, 'OPEN CHAMBER', 'Yuri'],
    [2, 'My Studio', 'My Studio'],
    [2, '', ''],
    [2, '  ', '  '],
    [3, 'OPEN CHAMBER', 'OPEN CHAMBER'],
  ])('rehydrates version %i name %j without overwriting custom intent', async (version, name, expected) => {
    const key = 'sidebar-brand-store';
    saved.set(key, JSON.stringify({ state: { sidebarBrandName: name }, version }));
    await act(async () => {
      await useSidebarBrandStore.persist.rehydrate();
      root.render(<SidebarBrandMark />);
    });
    expect(useSidebarBrandStore.getState().sidebarBrandName).toBe(expected);
    expect(JSON.parse(saved.get(key)!).state.sidebarBrandName).toBe(expected);
    expect(container.querySelector('[role="img"]') !== null).toBe(expected === 'Yuri');
    if (!expected.trim()) expect(container.innerHTML).toBe('');
  });
});
