import type { ChatInputSurface } from './chatInputSurface';

/**
 * The currently mounted, active composer surface (primary chat or Assistant).
 * Global shortcuts (Ctrl+X leader chords, model hotkeys) target this surface so
 * Assistant reuses the same session-composer behavior instead of a parallel path.
 */
let activeSurface: ChatInputSurface | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

export const isChatComposerMainTab = (tab: string | null | undefined): boolean => (
  tab === 'chat' || tab === 'assistant'
);

export const getActiveChatInputSurface = (): ChatInputSurface | null => activeSurface;

export const setActiveChatInputSurface = (surface: ChatInputSurface | null): void => {
  if (activeSurface === surface) return;
  activeSurface = surface;
  notify();
};

export const clearActiveChatInputSurface = (surfaceID?: string): void => {
  if (!activeSurface) return;
  if (surfaceID && activeSurface.surfaceID !== surfaceID) return;
  activeSurface = null;
  notify();
};

export const subscribeActiveChatInputSurface = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
