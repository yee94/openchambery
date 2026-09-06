import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import {
  INITIAL_LYNX_NAVIGATION_STATE,
  isDockHidden,
  lynxChatStackWindow,
  reconcileLynxChatPredecessor,
  reduceLynxNavigation,
  resolveLynxSecondaryBackDecision,
} from './navigation';
import { LYNX_TAB_IDS, LYNX_TABS } from './tabs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('Lynx four-root dock IA', () => {
  test('exposes exactly the four Cap tab ids and never a chat tab', () => {
    expect(LYNX_TAB_IDS).toEqual(['projects', 'assistant', 'scheduled', 'settings']);
    expect(LYNX_TABS.some((tab) => tab.id === 'chat' as never)).toBe(false);
  });

  test('stays aligned with Capacitor mobileTabs.ts', async () => {
    const source = await readFile(join(repoRoot, 'packages/ui/src/mobile/mobileTabs.ts'), 'utf8');
    expect(source).toContain("export type MobileTabId = 'projects' | 'assistant' | 'scheduled' | 'settings'");
    for (const tab of LYNX_TABS) {
      expect(source).toContain(`id: '${tab.id}'`);
      expect(source).toContain(`labelKey: '${tab.labelKey}'`);
    }
    expect(source).not.toContain("id: 'chat'");
  });

  test('opens chat as a pushed secondary page and hides the dock', () => {
    const opened = reduceLynxNavigation(INITIAL_LYNX_NAVIGATION_STATE, {
      type: 'openChat',
      sessionId: 'ses_1',
      directory: '/repo',
    });
    expect(opened.activeTab).toBe('projects');
    expect(opened.secondary).toEqual({
      kind: 'chat',
      routes: [{ key: 'chat-primary', sessionId: 'ses_1', directory: '/repo' }],
    });
    expect(isDockHidden(opened)).toBe(true);
  });

  test('switching a root tab closes the secondary page', () => {
    const chat = reduceLynxNavigation(INITIAL_LYNX_NAVIGATION_STATE, {
      type: 'openChat',
      sessionId: 'ses_1',
    });
    const next = reduceLynxNavigation(chat, { type: 'setActiveTab', tab: 'settings' });
    expect(next).toEqual({ activeTab: 'settings', secondary: null });
    expect(isDockHidden(next)).toBe(false);
  });

  test('pops nested chat then closes secondary', () => {
    const root = reduceLynxNavigation(INITIAL_LYNX_NAVIGATION_STATE, {
      type: 'openChat',
      sessionId: 'parent',
    });
    const child = reduceLynxNavigation(root, { type: 'pushChat', sessionId: 'child' });
    expect(child.secondary?.kind === 'chat' && child.secondary.routes).toHaveLength(2);
    const popped = reduceLynxNavigation(child, { type: 'popChat' });
    expect(popped.secondary?.kind === 'chat' && popped.secondary.routes[0]?.sessionId).toBe('parent');
    const closed = reduceLynxNavigation(popped, { type: 'popChat' });
    expect(closed.secondary).toBeNull();
  });

  test('back from a nested chat pops the predecessor', () => {
    const decision = resolveLynxSecondaryBackDecision({
      secondary: {
        kind: 'chat',
        routes: [
          { key: 'chat-primary', sessionId: 'parent', directory: null },
          { key: 'chat-push-child', sessionId: 'child', directory: null },
        ],
      },
      parentSessionTarget: null,
    });
    expect(decision).toEqual({
      action: 'popChatSession',
      parent: { id: 'parent', directory: null },
    });
  });

  test('reconciles deep-linked child with authoritative parent predecessor', () => {
    const childOnly = [
      { key: 'chat-primary', sessionId: 'child', directory: '/repo' },
    ];
    const reconciled = reconcileLynxChatPredecessor(childOnly, {
      key: 'chat-parent',
      sessionId: 'parent',
      directory: '/repo',
    });
    expect(reconciled.map((route) => route.sessionId)).toEqual(['parent', 'child']);
    expect(lynxChatStackWindow(reconciled).predecessor?.sessionId).toBe('parent');

    const viaReducer = reduceLynxNavigation(
      {
        activeTab: 'projects',
        secondary: { kind: 'chat', routes: childOnly },
      },
      { type: 'reconcileChatParent', sessionId: 'parent', directory: '/repo' },
    );
    expect(viaReducer.secondary?.kind === 'chat' && viaReducer.secondary.routes.map((r) => r.sessionId))
      .toEqual(['parent', 'child']);
  });

  test('draft / assistant / instances are secondary pages, not tabs', () => {
    const draft = reduceLynxNavigation(INITIAL_LYNX_NAVIGATION_STATE, { type: 'openDraft' });
    const assistant = reduceLynxNavigation(INITIAL_LYNX_NAVIGATION_STATE, { type: 'openAssistant', assistantId: 'asst_1' });
    const instances = reduceLynxNavigation(INITIAL_LYNX_NAVIGATION_STATE, { type: 'openInstances' });
    expect(draft.secondary?.kind).toBe('draft');
    expect(assistant.secondary).toMatchObject({ kind: 'assistant', assistantId: 'asst_1', sessionId: null });
    expect(instances.secondary?.kind).toBe('instances');
    expect(isDockHidden(draft)).toBe(true);
    expect(isDockHidden(assistant)).toBe(true);
    expect(isDockHidden(instances)).toBe(true);
  });
});
