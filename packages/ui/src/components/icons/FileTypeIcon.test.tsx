import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GuiFileIconsContext } from '@/lib/gui-plugins/react';
import { FileTypeIcon } from './FileTypeIcon';

vi.mock('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => undefined }));
const cleanups: (() => void)[] = [];
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); vi.unstubAllGlobals(); });

it('uses a plugin image across reloads and falls back on failure, disable, or missing provider', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => { act(() => root.unmount()); container.remove(); });
  let source = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E';
  const listeners = new Set<() => void>();
  const icons = {
    get: vi.fn((path: string, options?: { isDirectory?: boolean }) => !options?.isDirectory && path.endsWith('.eficy') ? source : undefined),
    subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
  };
  const render = (enabled = true) => act(() => root.render(
    <GuiFileIconsContext.Provider value={enabled ? icons : null}>
      <FileTypeIcon filePath="workbench.eficy" className="h-3.5" />
      <FileTypeIcon filePath="ordinary.txt" />
      <FileTypeIcon filePath="folder.eficy" isDirectory />
    </GuiFileIconsContext.Provider>,
  ));
  await render();
  const image = container.querySelector('img')!;
  expect(image.getAttribute('src')).toBe(source);
  expect(image.getAttribute('alt')).toBe('');
  expect(image.classList.contains('h-3.5')).toBe(true);
  expect(container.querySelectorAll('svg')).toHaveLength(2);
  expect(container.querySelector('use[href="#folder"]')).not.toBeNull();
  for (let i = 0; i < 50; i++) await act(() => { for (const listener of listeners) listener(); });
  expect(container.querySelector('img')).toBe(image);
  expect(icons.subscribe).toHaveBeenCalledTimes(3);
  await act(() => { image.dispatchEvent(new Event('error')); });
  expect(container.querySelector('img')).toBeNull();
  source += '#reloaded';
  await act(() => { for (const listener of listeners) listener(); });
  expect(container.querySelector('img')?.getAttribute('src')).toBe(source);
  await render(false);
  expect(container.querySelector('img')).toBeNull();
  expect(listeners.size).toBe(0);
});
