import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ commands: [], skills: [], messages: [] }));
vi.mock('@/queries/commandQueries', () => ({ useCommandsQuery: () => ({ data: fixtures.commands, isFetching: false }) }));
vi.mock('@/queries/installedSkillsQueries', () => ({ useInstalledSkillsQuery: () => ({ data: fixtures.skills }) }));
vi.mock('@/sync/sync-context', () => ({ useSessionMessages: () => fixtures.messages }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: (selector: (state: unknown) => unknown) => selector({ currentSessionId: null, newSessionDraft: null, getDirectoryForSession: () => '/repo' }) }));
vi.mock('@/lib/i18n', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/i18n')>();
  const { dict } = await import('@/lib/i18n/messages/en');
  const t = (key: keyof typeof dict) => dict[key];
  return { ...original, useI18n: () => ({ t, locale: 'en' }) };
});
import { CommandAutocomplete, type CommandAutocompleteHandle } from './CommandAutocomplete';
import { useUIStore } from '@/stores/useUIStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; });

test.each([false, true])('btw discovery and Enter/tap open the side conversation directly (mobile=%s)', async (isMobile) => {
  useUIStore.setState({ isMobile });
  const ref = React.createRef<CommandAutocompleteHandle>();
  const select = vi.fn();
  await act(async () => root.render(<CommandAutocomplete ref={ref} searchQuery="btw" directory="/repo" onCommandSelect={select} onClose={() => {}}
    commandContext={{ sessionID: 'session-a', hasMessages: true, hasNewDraft: false }} />));
  expect(document.body.textContent).toContain('/btw');
  await act(async () => ref.current!.handleKeyDown('Enter'));
  expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'btw', source: 'openchamber' }), true);
  await act(async () => ref.current!.acceptIndex(0, true));
  expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'btw' }), true);
});

test('btw discovery requires an existing session', async () => {
  await act(async () => root.render(<CommandAutocomplete searchQuery="btw" onCommandSelect={() => {}} onClose={() => {}}
    commandContext={{ sessionID: null, hasMessages: false, hasNewDraft: true }} />));
  expect(document.body.textContent).not.toContain('/btw');
});
