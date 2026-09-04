import { beforeEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

beforeEach(() => {
  useUIStore.setState({
    contextPanelByDirectory: {},
    contextToolDiffByDirectory: {},
    sessionWorkspacePanelById: {},
    contextPanelsOpenBeforeRightSidebarCollapse: [],
    isRightSidebarOpen: false,
    rightSidebarTab: 'git',
    pendingFileFocusPath: null,
    pendingFileViewerMode: null,
  });
});

describe('useUIStore context panel tabs', () => {
  test('opens a turn-scoped file diff at the requested line', () => {
    const directory = '/repo';

    useUIStore.getState().openContextDiff(directory, 'src/app.ts', false, 'turn', 42, ' msg_turn_1 ', ' ses_child ');

    const tab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs[0];
    expect(tab?.mode).toBe('diff');
    expect(tab?.targetPath).toBe('src/app.ts');
    expect(tab?.diffScope).toBe('turn');
    expect(tab?.diffTargetLine).toBe(42);
    expect(tab?.diffTurnMessageId).toBe('msg_turn_1');
    expect(tab?.diffSessionId).toBe('ses_child');

    useUIStore.getState().openContextDiff(directory, 'src/app.ts', false, 'turn', 7, 'msg_turn_2', 'ses_child_2');

    const reopenedTabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(reopenedTabs).toHaveLength(1);
    expect(reopenedTabs[0]?.diffTargetLine).toBe(7);
    expect(reopenedTabs[0]?.diffTurnMessageId).toBe('msg_turn_2');
    expect(reopenedTabs[0]?.diffSessionId).toBe('ses_child_2');
  });

  test('opens a file preview with a degraded turn-diff notice', () => {
    const directory = '/repo';

    useUIStore.getState().openContextFile(directory, '/Users/dev/.config/opencode/skills/clonedeps/SKILL.md', {
      fileNotice: 'turn-diff-outside-workspace',
    });

    const tab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs[0];
    expect(tab?.mode).toBe('file');
    expect(tab?.targetPath).toBe('/Users/dev/.config/opencode/skills/clonedeps/SKILL.md');
    expect(tab?.fileNotice).toBe('turn-diff-outside-workspace');

    useUIStore.getState().openContextFile(directory, '/Users/dev/.config/opencode/skills/clonedeps/SKILL.md');

    const cleared = useUIStore.getState().contextPanelByDirectory[directory]?.tabs[0];
    expect(cleared?.fileNotice).toBe(null);
  });

  test('opens an html file with a pending preview viewer mode', () => {
    const directory = '/repo';

    useUIStore.getState().openContextFile(directory, '/repo/ignore/report.html', {
      viewerMode: 'preview',
    });

    expect(useUIStore.getState().pendingFileViewerMode).toBe('preview');
    expect(useUIStore.getState().pendingFileFocusPath).toBe('/repo/ignore/report.html');

    useUIStore.getState().openContextFile(directory, '/repo/src/a.ts');

    expect(useUIStore.getState().pendingFileViewerMode).toBe(null);
    expect(useUIStore.getState().pendingFileFocusPath).toBe('/repo/src/a.ts');
  });

  test('keeps a clicked tool patch transient and clears it for regular diff navigation', () => {
    const directory = '/repo';
    const patch = '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n ';
    const secondPatch = '--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1 +1 @@\n-left\n+right\n ';

    useUIStore.getState().openContextToolDiff(directory, 'src/app.ts', [
      { path: 'src/app.ts', patch },
      { path: 'src/test.ts', patch: secondPatch },
    ], 1, ' msg_tool_turn ');

    const tab = useUIStore.getState().contextPanelByDirectory[directory]?.tabs[0];
    expect(tab?.mode).toBe('diff');
    expect(tab?.targetPath).toBe('src/app.ts');
    expect(tab?.diffScope).toBe('turn');
    expect(tab?.diffTurnMessageId).toBe('msg_tool_turn');
    expect(useUIStore.getState().contextToolDiffByDirectory[directory]).toEqual({
      targetPath: 'src/app.ts',
      patches: [
        { path: 'src/app.ts', patch },
        { path: 'src/test.ts', patch: secondPatch },
      ],
      turnMessageId: 'msg_tool_turn',
    });
    const partialize = useUIStore.persist.getOptions().partialize;
    const persisted = partialize?.(useUIStore.getState()) as Record<string, unknown> | undefined;
    expect(persisted?.contextToolDiffByDirectory).toBe(undefined);

    useUIStore.getState().openContextDiff(directory, 'src/app.ts', false, 'turn', 1, 'msg_turn');

    expect(useUIStore.getState().contextToolDiffByDirectory[directory]).toBe(undefined);
  });

  test('updates readOnly when an existing chat tab is reopened', () => {
    const directory = '/repo';

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_1',
      label: 'Session',
      readOnly: true,
    });

    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_1',
      label: 'Session',
      readOnly: false,
    });

    const tabs = useUIStore.getState().contextPanelByDirectory[directory]?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.readOnly).toBe(false);
  });

  test('closeActiveContextPanelTab closes the active tab and shuts the panel when empty', () => {
    const directory = '/repo';

    useUIStore.getState().openContextPanelTab(directory, { mode: 'context' });
    useUIStore.getState().openContextPanelTab(directory, {
      mode: 'file',
      targetPath: '/repo/install.sh',
    });

    const before = useUIStore.getState().contextPanelByDirectory[directory];
    expect(before?.isOpen).toBe(true);
    expect(before?.tabs).toHaveLength(2);

    const closedFirst = useUIStore.getState().closeActiveContextPanelTab(directory);
    expect(closedFirst).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs).toHaveLength(1);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(true);

    const closedLast = useUIStore.getState().closeActiveContextPanelTab(directory);
    expect(closedLast).toBe(true);
    const after = useUIStore.getState().contextPanelByDirectory[directory];
    expect(after?.tabs).toHaveLength(0);
    expect(after?.isOpen).toBe(false);

    expect(useUIStore.getState().closeActiveContextPanelTab(directory)).toBe(false);
  });

  test('toggles open context panels with the right sidebar and restores them', () => {
    const firstDirectory = '/repo-one';
    const secondDirectory = '/repo-two';
    const store = useUIStore.getState();

    store.openContextPanelTab(firstDirectory, { mode: 'context' });
    store.openContextPanelTab(secondDirectory, { mode: 'diff' });
    store.toggleRightSidebar();

    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
    store.toggleRightSidebar();

    expect(useUIStore.getState().isRightSidebarOpen).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory[firstDirectory]?.isOpen).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory[secondDirectory]?.isOpen).toBe(false);

    store.toggleRightSidebar();

    expect(useUIStore.getState().contextPanelByDirectory[firstDirectory]?.isOpen).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory[secondDirectory]?.isOpen).toBe(true);
  });

  test('syncWorkspacePanelsForSessionSwitch hides and restores session-scoped panels', () => {
    const directory = '/repo';
    const store = useUIStore.getState();

    store.openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_child',
      label: 'Subagent',
    });
    store.openContextFile(directory, '/repo/src/a.ts');
    store.setRightSidebarOpen(true);
    store.setRightSidebarTab('git');

    const activeTabId = useUIStore.getState().contextPanelByDirectory[directory]?.activeTabId;
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(true);
    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);

    store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId: 'ses_a',
      previousDirectory: directory,
      nextSessionId: 'ses_b',
      nextDirectory: directory,
    });

    expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(false);
    expect(useUIStore.getState().isRightSidebarOpen).toBe(false);
    // Tabs stay cached so restore can reopen them.
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs.length).toBeGreaterThan(0);

    store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId: 'ses_b',
      previousDirectory: directory,
      nextSessionId: 'ses_a',
      nextDirectory: directory,
    });

    expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory[directory]?.activeTabId).toBe(activeTabId);
    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
    expect(useUIStore.getState().rightSidebarTab).toBe('git');
  });

  test('syncWorkspacePanelsForSessionSwitch closes previous directory when roots differ', () => {
    const firstDirectory = '/repo-one';
    const secondDirectory = '/repo-two';
    const store = useUIStore.getState();

    store.openContextPanelTab(firstDirectory, {
      mode: 'chat',
      dedupeKey: 'session:ses_child',
      label: 'Subagent',
    });
    expect(useUIStore.getState().contextPanelByDirectory[firstDirectory]?.isOpen).toBe(true);

    store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId: 'ses_a',
      previousDirectory: firstDirectory,
      nextSessionId: 'ses_b',
      nextDirectory: secondDirectory,
    });

    expect(useUIStore.getState().contextPanelByDirectory[firstDirectory]?.isOpen).toBe(false);
    expect(useUIStore.getState().isRightSidebarOpen).toBe(false);
  });

  test('syncWorkspacePanelsForSessionSwitch hides panels when leaving for a new-session draft', () => {
    const directory = '/repo';
    const store = useUIStore.getState();

    store.openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: 'session:ses_child',
      label: 'Subagent',
    });
    store.setRightSidebarOpen(true);
    store.setRightSidebarTab('files');

    store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId: 'ses_a',
      previousDirectory: directory,
      nextSessionId: null,
      nextDirectory: null,
    });

    expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(false);
    expect(useUIStore.getState().isRightSidebarOpen).toBe(false);
    expect(useUIStore.getState().sessionWorkspacePanelById.ses_a?.isRightSidebarOpen).toBe(true);
    expect(useUIStore.getState().sessionWorkspacePanelById.ses_a?.rightSidebarTab).toBe('files');

    store.syncWorkspacePanelsForSessionSwitch({
      previousSessionId: null,
      previousDirectory: null,
      nextSessionId: 'ses_a',
      nextDirectory: directory,
    });

    expect(useUIStore.getState().contextPanelByDirectory[directory]?.isOpen).toBe(true);
    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
    expect(useUIStore.getState().rightSidebarTab).toBe('files');
  });
});
