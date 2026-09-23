import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';

const { requestTitle } = vi.hoisted(() => ({ requestTitle: vi.fn(() => new Promise<void>(() => {})) }));
vi.mock('@/sync/session-actions', () => ({ requestSessionSmartTitle: requestTitle }));
vi.mock('@/sync/sync-context', () => ({
  useDirectoryStore: () => null,
  useLiveSessionStatus: () => ({ type: 'busy' }),
  useSessionPermissions: () => [],
  useSessionQuestions: () => [],
}));
vi.mock('@/sync/use-sync', () => ({ useSync: () => ({}) }));
vi.mock('./sessionFolderDnd', () => ({ DraggableSessionRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/multirun/MultiRunFusionDialog', () => ({ MultiRunFusionDialog: () => null }));
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  getCurrentIntlLocale: () => 'en-US',
  t: (key: string) => key,
}));
vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ home: '/workspace', data: [] })));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

import { SessionNodeItem } from './SessionNodeItem';
import { TooltipProvider } from '@/components/ui/tooltip';

const noop = () => {};
const session = { id: 'ses_title', title: 'Original title', directory: '/repo', time: { created: 1, updated: 2 } } as Session;
const container = document.createElement('div');
document.body.append(container);
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root?.unmount());
  requestTitle.mockClear();
});
afterAll(() => {
  container.remove();
  vi.unstubAllGlobals();
});

function Harness({ live = session, editing = true }: { live?: Session; editing?: boolean }) {
  const [editingId, setEditingId] = React.useState<string | null>(editing ? session.id : null);
  return <TooltipProvider><SessionNodeItem
    node={{ session, children: [], worktree: null }}
    groupDirectory="/repo"
    currentSessionId={null}
    pinnedSessionIds={new Set()}
    expandedParents={new Set()}
    hasSessionSearchQuery={false}
    normalizedSessionSearchQuery=""
    notifyOnSubtasks={false}
    editingId={editingId}
    setEditingId={setEditingId}
    editTitle={session.title ?? ''}
    setEditTitle={noop}
    handleSaveEdit={noop}
    handleCancelEdit={() => setEditingId(null)}
    toggleParent={noop}
    handleSessionSelect={noop}
    handleSessionDoubleClick={noop}
    togglePinnedSession={noop}
    handleShareSession={noop}
    copiedSessionId={null}
    handleCopyShareUrl={noop}
    handleUnshareSession={noop}
    openSidebarMenuKey={null}
    setOpenSidebarMenuKey={noop}
    renamingFolderId={null}
    getFoldersForScope={() => []}
    getSessionFolderId={() => null}
    removeSessionFromFolder={noop}
    addSessionToFolder={noop}
    createFolderAndStartRename={() => null}
    openContextPanelTab={noop}
    handleDeleteSession={noop}
    mobileVariant={false}
    alwaysShowActions={false}
    renderSessionNode={() => null}
    subtreeContainsActive={new Set()}
    subtreeContainsEditing={new Set([session.id])}
    menuOpenSessionId={null}
    nodeStructureKey={session.id}
    liveSessionById={new Map([[session.id, live]])}
  /></TooltipProvider>;
}

test('AI title click immediately shows the title loading while the request is pending', async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  const button = container.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.session.rename.smartTitle"]');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  expect(requestTitle).toHaveBeenCalledWith(session.id);
  expect(container.querySelector('[aria-busy="true"]')?.textContent).toBe(session.title);
  expect(container.querySelector('[aria-busy="true"]')?.classList.contains('animate-text-shimmer')).toBe(true);
});

test('server first-title generation shows loading without clicking the AI button', async () => {
  root = createRoot(container);
  const generating = { ...session, title: '', metadata: { openchamber: { titleRefresh: { isGenerating: true } } } } as Session;
  await act(async () => root.render(<Harness editing={false} live={generating} />));
  expect(container.querySelector('[aria-busy="true"]')?.classList.contains('animate-text-shimmer')).toBe(true);
  expect(requestTitle).not.toHaveBeenCalled();
  const completed = { ...session, title: 'Generated first title' };
  await act(async () => root.render(<Harness editing={false} live={completed} />));
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(container.textContent).toContain('Generated first title');
});
