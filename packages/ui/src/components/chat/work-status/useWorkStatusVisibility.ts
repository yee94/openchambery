import { useMediaQuery } from '@reactuses/core';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

/** Fixed card width. It is not a docked pane, so it has no resizer. */
export const WORK_STATUS_PANEL_WIDTH = 196;

/** Use the viewport breakpoint from the first render, before transcript layout. */
const WORK_STATUS_MIN_WINDOW_WIDTH = 1440;

type Options = {
  isMobile: boolean;
  isVSCode: boolean;
  directory: string | null;
};

type Result = {
  visible: boolean;
  fits: boolean;
  layoutAllows: boolean;
};

/**
 * Whether the card may sit beside the transcript.
 *
 * The viewport decides before the first paint. Transcript loading and sidebar
 * layout measurements cannot change the breakpoint decision.
 */
export const useWorkStatusVisibility = ({ isMobile, isVSCode, directory }: Options): Result => {
  const wideWindow = useMediaQuery(`(min-width: ${WORK_STATUS_MIN_WINDOW_WIDTH}px)`);

  const directoryKey = directory ? normalizeContextPanelDirectoryKey(directory) : '';
  const contextPanelOpen = useUIStore((state) => {
    const panel = directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined;
    if (!panel?.isOpen) return false;
    const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId) ?? panel.tabs[panel.tabs.length - 1] ?? null;
    return Boolean(activeTab);
  });
  const panelEnabled = useUIStore((state) => state.workStatusPanelEnabled);
  const rightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
  // The right sidebar already occupies this edge. Keep the column off while it
  // is open so the two do not stack; the preference itself stays put.
  const layoutAllows = !isMobile && !isVSCode && !contextPanelOpen && !rightSidebarOpen;

  const fits = layoutAllows && wideWindow;
  const visible = panelEnabled && fits;

  return { visible, fits, layoutAllows };
};
