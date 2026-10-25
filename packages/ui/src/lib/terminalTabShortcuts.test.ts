import { beforeEach, describe, expect, test } from 'bun:test';

import {
  closeActiveTerminalTab,
  createAndActivateTerminalTab,
  switchTerminalTab,
} from './terminalTabShortcuts';
import { useTerminalStore } from '@/stores/useTerminalStore';

const DIRECTORY = '/tmp/yuri-terminal-tabs';

describe('terminalTabShortcuts', () => {
  beforeEach(() => {
    useTerminalStore.setState({
      sessions: new Map(),
      projectActionRuns: {},
      nextChunkId: 1,
      nextTabId: 1,
      hasHydrated: true,
    });
  });

  test('createAndActivateTerminalTab creates and focuses the new tab', () => {
    const firstId = createAndActivateTerminalTab(DIRECTORY);
    const secondId = createAndActivateTerminalTab(DIRECTORY);

    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);

    const state = useTerminalStore.getState().getDirectoryState(DIRECTORY);
    expect(state?.tabs).toHaveLength(2);
    expect(state?.activeTabId).toBe(secondId);
  });

  test('switchTerminalTab cycles previous and next tabs', () => {
    const firstId = createAndActivateTerminalTab(DIRECTORY);
    const secondId = createAndActivateTerminalTab(DIRECTORY);
    const thirdId = createAndActivateTerminalTab(DIRECTORY);

    expect(useTerminalStore.getState().getDirectoryState(DIRECTORY)?.activeTabId).toBe(thirdId);

    expect(switchTerminalTab(DIRECTORY, -1)).toBe(true);
    expect(useTerminalStore.getState().getDirectoryState(DIRECTORY)?.activeTabId).toBe(secondId);

    expect(switchTerminalTab(DIRECTORY, -1)).toBe(true);
    expect(useTerminalStore.getState().getDirectoryState(DIRECTORY)?.activeTabId).toBe(firstId);

    expect(switchTerminalTab(DIRECTORY, 1)).toBe(true);
    expect(useTerminalStore.getState().getDirectoryState(DIRECTORY)?.activeTabId).toBe(secondId);
  });

  test('closeActiveTerminalTab closes the active tab and reports last-tab close', async () => {
    const firstId = createAndActivateTerminalTab(DIRECTORY);
    const secondId = createAndActivateTerminalTab(DIRECTORY);
    expect(secondId).toBeTruthy();

    const firstClose = closeActiveTerminalTab(DIRECTORY);
    expect(firstClose).toEqual({ closed: true, wasLastTab: false });

    await Promise.resolve();
    expect(useTerminalStore.getState().getDirectoryState(DIRECTORY)?.tabs).toHaveLength(1);
    expect(useTerminalStore.getState().getDirectoryState(DIRECTORY)?.activeTabId).toBe(firstId);

    const lastClose = closeActiveTerminalTab(DIRECTORY);
    expect(lastClose).toEqual({ closed: true, wasLastTab: true });

    await Promise.resolve();
    // Store keeps a replacement empty tab after the last real tab closes.
    expect(useTerminalStore.getState().getDirectoryState(DIRECTORY)?.tabs).toHaveLength(1);
    expect(useTerminalStore.getState().getDirectoryState(DIRECTORY)?.activeTabId).not.toBe(firstId);
  });
});
