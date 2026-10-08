import * as React from 'react';
import { CommandPalette } from '@/components/ui/CommandPalette';
import { holdNativeComposerCover } from '@/lib/nativeComposerCover';
import { useUIStore } from '@/stores/useUIStore';
import { mobileBackNavigationCoordinator, useMobileBackRoute } from './mobileBackNavigation';

/** Retains the current mobile screen underneath the independent search push page. */
export function MobileGlobalSearchHost({ children }: { children: React.ReactNode }) {
  const open = useUIStore((state) => state.isCommandPaletteOpen);
  const setOpen = useUIStore((state) => state.setCommandPaletteOpen);
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const underlayRef = React.useRef<HTMLDivElement>(null);

  useMobileBackRoute({
    id: 'mobile-global-search',
    active: open,
    onBack: () => setOpen(false),
    surfaceRef,
    underlayRef,
  });

  React.useLayoutEffect(() => {
    if (!open) return;
    const trigger = document.activeElement;
    const release = holdNativeComposerCover('global-search-page');
    return () => {
      release();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [open]);

  return (
    <div className="relative isolate flex h-[100dvh] min-h-0 w-full flex-col overflow-hidden bg-background" data-page-scroll-lock="true">
      <div ref={underlayRef} inert={open || undefined} aria-hidden={open || undefined} className="h-full min-h-0 w-full">
        {children}
      </div>
      {open ? (
        <div ref={surfaceRef} data-mobile-search-page="true" className="absolute inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-background" data-page-scroll-lock="true">
          <CommandPalette presentation="page" onBack={() => { mobileBackNavigationCoordinator.requestAnimatedBack('root'); }} />
        </div>
      ) : null}
    </div>
  );
}
