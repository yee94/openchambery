import { pushPhoneBtw } from '@/mobile/useMobileNavigationStore';
import { useUIStore } from '@/stores/useUIStore';
import type { SessionBtwScope } from '@/stores/useSessionBtwStore';

/** Focus the side-conversation composer once the panel has rendered. */
const focusBtwComposer = (): void => {
  if (typeof window === 'undefined') return;
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('[data-btw-composer] textarea')?.focus();
  });
};

/** Phone shell pushes the btw page; every other layout opens the ContextPanel tab / sheet. */
export const openSessionBtw = (scope: SessionBtwScope): void => {
  const directory = scope.directory ?? null;
  if (!pushPhoneBtw({ sessionId: scope.sessionId, directory })) {
    useUIStore.getState().openContextPanelTab(directory ?? '', { mode: 'btw' });
  }
  focusBtwComposer();
};
