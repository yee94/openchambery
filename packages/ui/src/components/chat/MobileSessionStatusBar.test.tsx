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
  SessionItem,
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

describe('MobileSessionStatusBar phone navigation contracts', () => {
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
    expect(statusBarSource).toContain("label={t('sessions.sidebar.session.menu.rename')}");
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
