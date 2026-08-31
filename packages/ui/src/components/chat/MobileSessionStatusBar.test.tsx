import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@opencode-ai/sdk/v2';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import {
  handleMobileSessionContextMenu,
  preventMobileSessionTouchStartBaseUIHandler,
  resolveMobileSessionSheetDefaultFilter,
  SessionItem,
  shouldPreserveActiveProjectOnSessionOpen,
} from './MobileSessionStatusBar';

const statusBarSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'MobileSessionStatusBar.tsx'),
  'utf-8',
);

const session = {
  id: 'ses-touch-menu',
  title: 'Touch menu session',
  time: { created: 1, updated: 1 },
  _statusType: 'idle',
} as Session & { _statusType: 'idle' };

describe('MobileSessionStatusBar SessionItem', () => {
  test('blocks Base UI touch long-press handling', () => {
    let preventBaseUIHandlerCalls = 0;

    preventMobileSessionTouchStartBaseUIHandler({
      preventBaseUIHandler: () => {
        preventBaseUIHandlerCalls += 1;
      },
    });

    expect(preventBaseUIHandlerCalls).toBe(1);
  });

  test('leaves mouse and keyboard context menus to Base UI when no touch long-press is active', () => {
    let preventBaseUIHandlerCalls = 0;
    let customContextMenuCalls = 0;
    const event = {
      preventBaseUIHandler: () => {
        preventBaseUIHandlerCalls += 1;
      },
    } as React.MouseEvent<HTMLElement> & { preventBaseUIHandler: () => void };

    handleMobileSessionContextMenu(event, false, () => {
      customContextMenuCalls += 1;
    });

    expect(preventBaseUIHandlerCalls).toBe(0);
    expect(customContextMenuCalls).toBe(0);
  });

  test('routes contextmenu generated during a touch long-press to the action sheet', () => {
    let preventBaseUIHandlerCalls = 0;
    let customContextMenuCalls = 0;
    const event = {
      preventBaseUIHandler: () => {
        preventBaseUIHandlerCalls += 1;
      },
    } as React.MouseEvent<HTMLElement> & { preventBaseUIHandler: () => void };

    handleMobileSessionContextMenu(event, true, () => {
      customContextMenuCalls += 1;
    });

    expect(preventBaseUIHandlerCalls).toBe(1);
    expect(customContextMenuCalls).toBe(1);
  });

  test('renders the screenshot session row as both a long-press and context-menu trigger', () => {
    const longPressHandlers = {
      pressed: false,
      onPointerDown: () => undefined,
      onPointerMove: () => undefined,
      onPointerUp: () => undefined,
      onPointerCancel: () => undefined,
      onContextMenu: () => undefined,
    };
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <SessionItem
          session={session}
          isCurrent={false}
          isPinned={false}
          getSessionTitle={(value) => value.title ?? value.id}
          onClick={() => undefined}
          onRename={() => undefined}
          onTogglePinned={() => undefined}
          onShare={() => undefined}
          onCopyShareUrl={() => undefined}
          onUnshare={() => undefined}
          onArchive={() => undefined}
          needsAttention={() => false}
          longPressHandlers={longPressHandlers}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('data-mobile-session-context-trigger="ses-touch-menu"');
    expect(markup).toContain('data-mobile-long-press-trigger="session:ses-touch-menu"');
    expect(markup).toContain('-webkit-touch-callout:none');
    expect(markup).toContain('-webkit-user-select:none');
    expect(markup).toContain('user-select:none');
    expect(markup).toContain('Touch menu session');
  });
});

describe('MobileSessionStatusBar sheet default filter', () => {
  const projects = [{ id: 'project-a' }, { id: 'project-b' }];

  test('preserves "All" and only corrects a removed-project filter to the active project', () => {
    // Last open on "All" must stick — do not force the current project tab.
    expect(
      resolveMobileSessionSheetDefaultFilter({
        activeProjectId: 'project-a',
        currentFilterProjectId: null,
        projects,
      }),
    ).toBeNull();
    // Stale/unknown project is the only case that corrects to active project.
    expect(
      resolveMobileSessionSheetDefaultFilter({
        activeProjectId: 'project-a',
        currentFilterProjectId: 'project-removed',
        projects,
      }),
    ).toBe('project-a');
  });

  test('preserves the pinned scope and filters still matching a known project', () => {
    expect(
      resolveMobileSessionSheetDefaultFilter({
        activeProjectId: 'project-a',
        currentFilterProjectId: '__pinned_sessions__',
        projects,
      }),
    ).toBe('__pinned_sessions__');
    expect(
      resolveMobileSessionSheetDefaultFilter({
        activeProjectId: 'project-a',
        currentFilterProjectId: 'project-b',
        projects,
      }),
    ).toBe('project-b');
    // Current project tab is already the right choice — keep it.
    expect(
      resolveMobileSessionSheetDefaultFilter({
        activeProjectId: 'project-a',
        currentFilterProjectId: 'project-a',
        projects,
      }),
    ).toBe('project-a');
  });

  test('keeps the current filter when there is no active project', () => {
    expect(
      resolveMobileSessionSheetDefaultFilter({
        activeProjectId: null,
        currentFilterProjectId: null,
        projects,
      }),
    ).toBeNull();
    expect(
      resolveMobileSessionSheetDefaultFilter({
        activeProjectId: null,
        currentFilterProjectId: 'project-removed',
        projects,
      }),
    ).toBe('project-removed');
  });

  test('applies the open-time default only on the closed-to-open transition so taps made while open stick', () => {
    // Regression: the open-time default effect must not re-run while the sheet
    // stays open, otherwise tapping "All" is immediately overridden back to
    // the active project.
    expect(statusBarSource).toContain('const wasOpen = prevSheetOpenRef.current;');
    expect(statusBarSource).toContain('if (!open || wasOpen) return;');
  });
});

describe('MobileSessionStatusBar project correction on session open', () => {
  test('keeps the active project when the list scope is "All" or "Pinned"', () => {
    // Browsing past project boundaries is navigation only — opening one of
    // those sessions must not move the user's working project.
    expect(shouldPreserveActiveProjectOnSessionOpen(null)).toBe(true);
    expect(shouldPreserveActiveProjectOnSessionOpen('__pinned_sessions__')).toBe(true);
  });

  test('lets the active project follow the session when a concrete project is selected', () => {
    // The user narrowed to one project, so crossing into another project is a
    // real project switch and must stay corrected.
    expect(shouldPreserveActiveProjectOnSessionOpen('project-a')).toBe(false);
    expect(shouldPreserveActiveProjectOnSessionOpen('project-removed')).toBe(false);
  });

  test('forwards the choice to both the phone navigation path and the iPad store path', () => {
    expect(statusBarSource).toContain('preserveActiveProject,');
    expect(statusBarSource).toContain('void setCurrentSession(session.id, directory, { preserveActiveProject });');
  });
});

describe('MobileSessionStatusBar phone navigation contracts', () => {
  test('worktree session rows share the root list inset instead of a nested indent', () => {
    expect(statusBarSource).toContain('// Worktree sessions share the root list inset so titles align with');
    expect(statusBarSource).not.toContain("!isRoot && 'pl-4'");
  });

  test('new chat and worktree draft entry points use phone openDraft, not store-only draft open', () => {
    // Phone ChatView selectionOverride comes from the secondary route. Opening a
    // draft without openDraft leaves the previous session route mounted.
    expect(statusBarSource).toContain("useMobileNavigationStore.getState().openDraft(options)");
    expect(statusBarSource).toContain('const startNewSessionDraft = React.useCallback(');
    expect(statusBarSource).toContain('startNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path })');
    expect(statusBarSource).toContain('startNewSessionDraft({\n              selectedProjectId: worktreeDialogProjectId,');
    expect(statusBarSource).toContain('useMobileNavigationStore.getState().openSession({');
    expect(statusBarSource).toContain('forceRefreshProjectWorktreeCatalog');
  });

  test('session action sheet exposes rename and submits smart title without waiting for generation', () => {
    expect(statusBarSource).toContain('buildSessionMenuItems({');
    expect(statusBarSource).toContain('beginSessionRename(session)');
    expect(statusBarSource).toContain("t('sessions.sidebar.session.rename.smartTitle')");
    expect(statusBarSource).toContain('onRename={() => beginSessionRename(session)}');
    expect(statusBarSource).toContain('await requestSessionSmartTitle(sessionId)');
    // Close rename UI before awaiting title generation — submit-only.
    const smartTitleHandler = statusBarSource.slice(
      statusBarSource.indexOf('const handleRequestSmartTitle'),
      statusBarSource.indexOf('await requestSessionSmartTitle(sessionId)'),
    );
    expect(smartTitleHandler).toContain('setRenamingSession(null)');
  });
});
