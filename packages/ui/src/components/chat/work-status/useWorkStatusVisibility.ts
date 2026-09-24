import React from 'react';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

/** Fixed card width. It is not a docked pane, so it has no resizer. */
export const WORK_STATUS_PANEL_WIDTH = 196;

/** Transcript must keep at least this much once the card is beside it. */
const WORK_STATUS_MIN_CHAT_WIDTH = 560;

/** Card margins (`ml-2` + `mr-4`). */
const WORK_STATUS_PANEL_GUTTER = 8 + 16;

export const WORK_STATUS_REQUIRED_ROW_WIDTH =
  WORK_STATUS_PANEL_WIDTH + WORK_STATUS_PANEL_GUTTER + WORK_STATUS_MIN_CHAT_WIDTH;

type Options = {
  isMobile: boolean;
  isVSCode: boolean;
  directory: string | null;
};

type Result = {
  rowRef: (node: HTMLDivElement | null) => void;
  visible: boolean;
  fits: boolean;
  layoutAllows: boolean;
};

/**
 * Whether the card may sit beside the transcript.
 *
 * Width is read from `[data-chat-area]`, the box that holds the chat and the
 * context panel. Measuring the chat column itself oscillates: hiding the card
 * widens the column, which would show it again.
 */
export const useWorkStatusVisibility = ({ isMobile, isVSCode, directory }: Options): Result => {
  const [rowNode, setRowNode] = React.useState<HTMLDivElement | null>(null);
  const [rowWidth, setRowWidth] = React.useState<number | null>(null);
  const rowRef = React.useMemo(() => (node: HTMLDivElement | null) => { setRowNode(node); }, []);

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

  React.useEffect(() => {
    if (!rowNode || typeof ResizeObserver === 'undefined') return undefined;
    const measured = rowNode.closest<HTMLElement>('[data-chat-area]') ?? rowNode;
    setRowWidth(measured.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setRowWidth(entry.contentRect.width);
    });
    observer.observe(measured);
    return () => observer.disconnect();
  }, [rowNode]);

  const fits = layoutAllows && rowWidth !== null && rowWidth >= WORK_STATUS_REQUIRED_ROW_WIDTH;
  const visible = panelEnabled && fits;

  return { rowRef, visible, fits, layoutAllows };
};
