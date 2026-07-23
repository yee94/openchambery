import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { invokeDesktop, isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { useSidebarBrandStore } from '@/stores/useSidebarBrandStore';
import { SidebarBrandMark } from './SidebarBrandMark';
import { GlobalSearchButton } from './GlobalSearchButton';

const ICON_BUTTON_CLASS =
  'app-region-no-drag inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-interactive-hover hover:text-foreground transition-colors';

/**
 * Persistent top-left titlebar controls, with the Web wordmark sharing the
 * control row while the sidebar is open.
 *
 * Global search placement:
 * - Web: always next to the sidebar collapse control (same row as brand when open).
 * - Electron with a configured logo: in the fixed sidebar brand row while open;
 *   falls back here while the sidebar is collapsed.
 * - Electron without a logo: always here next to the collapse control (no empty
 *   brand row is reserved in the sidebar).
 *
 * Rendered exactly once as an absolutely-positioned overlay above both the
 * sidebar and the header, so native titlebar controls stay fixed while the
 * sidebar animates open or closed — the panels slide *underneath* the control
 * cluster instead. Its height tracks `--oc-header-height` and its left padding
 * clears the OS window controls via `--oc-titlebar-left-inset`. The cluster's
 * measured width is published as `--oc-titlebar-controls-width` so the header
 * can reserve matching space when the sidebar is collapsed.
 */
export const TitlebarLeftControls: React.FC = () => {
  const { t } = useI18n();
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const sidebarWidth = useUIStore((state) => state.sidebarWidth);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const hasSidebarBrand = useSidebarBrandStore((state) => state.sidebarBrandName.trim().length > 0);
  const clusterRef = React.useRef<HTMLDivElement | null>(null);

  const toggleShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_sidebar', shortcutOverrides));
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();
  const isDesktopShellRuntime = React.useMemo(() => isDesktopShell(), []);
  // Electron only moves search into the sidebar when a brand/logo is shown there.
  const showGlobalSearchInTitlebar = !isDesktopShellRuntime || !isSidebarOpen || !hasSidebarBrand;
  const usesWebSidebarHeader = React.useMemo(
    () => isWebRuntime() && !isDesktopShellRuntime && !isVSCodeRuntime(),
    [isDesktopShellRuntime],
  );

  const handleOpenWindowsAppMenu = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    void invokeDesktop('desktop_show_app_menu', {
      x: rect.left,
      y: rect.bottom,
    }).catch((error) => {
      console.warn('[titlebar] failed to open app menu', error);
    });
  }, []);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const node = clusterRef.current;
    if (!node) {
      return;
    }

    const publishWidth = () => {
      const width = node.getBoundingClientRect().width;
      document.documentElement.style.setProperty('--oc-titlebar-controls-width', `${Math.round(width)}px`);
    };

    publishWidth();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(publishWidth);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    // The overlay is a CSS no-drag zone so its buttons stay clickable. The
    // header / sidebar strip beneath carve a matching no-drag region under it
    // and remain drag regions everywhere else, so window dragging still works
    // in the empty parts of the strip.
    <div
      className="app-region-no-drag absolute left-0 top-0 z-30 flex select-none items-center pr-2"
      style={{
        height: 'var(--oc-header-height, 3rem)',
        paddingLeft: 'var(--oc-titlebar-left-inset, 0.75rem)',
        width: usesWebSidebarHeader && isSidebarOpen ? `${sidebarWidth || 260}px` : undefined,
      }}
    >
      <div
        ref={clusterRef}
        className={cn(
          'flex items-center gap-2',
          usesWebSidebarHeader && isSidebarOpen && 'w-full justify-between',
        )}
      >
        {usesWebSidebarHeader && isSidebarOpen ? (
          <SidebarBrandMark className="flex min-w-0 items-center p-0" />
        ) : null}

        {usesFramelessChrome && windowControlsSide === 'left' ? (
          <WindowsWindowControls visible position="left" />
        ) : null}

        {usesFramelessChrome ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleOpenWindowsAppMenu}
                aria-label={t('header.actions.openAppMenuAria')}
                className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
              >
                <Icon name="menu-2" className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('header.actions.openAppMenu')}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}

        <div className="flex shrink-0 items-center gap-1">
          {showGlobalSearchInTitlebar ? <GlobalSearchButton /> : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleSidebar}
                aria-label={t('header.actions.openSessionsAria')}
                className={cn(ICON_BUTTON_CLASS, 'group shrink-0')}
              >
                <Icon
                  name="layout-left-rounded"
                  className="size-4 text-foreground/55 transition-colors group-hover:text-foreground group-focus-visible:text-foreground"
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('header.actions.openSessionsWithShortcut', { shortcut: toggleShortcut })}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};
