import { useSyncExternalStore } from 'react';
import { invokeDesktop, isDesktopShell } from '@/lib/desktop';

let fullscreen = false;
let revision = 0;
const listeners = new Set<() => void>();

const refresh = async () => {
  const request = ++revision;
  try {
    const value = await invokeDesktop<boolean>('desktop_is_window_fullscreen');
    if (request !== revision || value === fullscreen) return;
    fullscreen = value === true;
    listeners.forEach((listener) => listener());
  } catch {
    // Keep the last confirmed native window state if IPC is unavailable.
  }
};

const subscribe = (listener: () => void) => {
  if (!isDesktopShell()) return () => {};
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener('yuri:window-resized', refresh);
    void refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('yuri:window-resized', refresh);
      revision++;
      fullscreen = false;
    }
  };
};

export function useDesktopWindowFullscreen(): boolean {
  return useSyncExternalStore(subscribe, () => fullscreen, () => false);
}
