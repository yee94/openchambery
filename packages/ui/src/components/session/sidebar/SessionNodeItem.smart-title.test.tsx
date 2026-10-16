import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';

const { requestTitle, loadChildren } = vi.hoisted(() => ({
  requestTitle: vi.fn(() => new Promise<void>(() => {})),
  loadChildren: vi.fn(async () => {}),
}));
vi.mock('@/sync/session-actions', () => ({ requestSessionSmartTitle: requestTitle }));
vi.mock('@/sync/sync-context', () => ({
  useDirectoryStore: () => null,
  useLiveSessionStatus: () => ({ type: 'busy' }),
  useSessionActivity: () => true,
  useSessionPermissions: () => [],
  useSessionQuestions: () => [],
}));
vi.mock('@/sync/use-sync', () => ({ useSync: () => ({ loadChildren }) }));
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
import { toast } from '@/components/ui';

const noop = () => {};
const session = { id: 'ses_title', title: 'Original title', directory: '/repo', time: { created: 1, updated: 2 } } as Session;
const container = document.createElement('div');
document.body.append(container);
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root?.unmount());
  requestTitle.mockClear();
  loadChildren.mockClear();
  vi.restoreAllMocks();
});
afterAll(() => {
  container.remove();
  vi.unstubAllGlobals();
});

function Harness({ live = session, editing = true, indexed = session, children = [] }: {
  live?: Session;
  editing?: boolean;
  indexed?: Session;
  children?: Array<{ session: Session; children: []; worktree: null }>;
}) {
  const [editingId, setEditingId] = React.useState<string | null>(editing ? session.id : null);
  const [expandedParents, setExpandedParents] = React.useState<Set<string>>(new Set());
  return <TooltipProvider><SessionNodeItem
    node={{ session: indexed, children, worktree: null }}
    groupDirectory="/repo"
    currentSessionId={null}
    pinnedSessionIds={new Set()}
    expandedParents={expandedParents}
    hasSessionSearchQuery={false}
    normalizedSessionSearchQuery=""
    notifyOnSubtasks={false}
    editingId={editingId}
    setEditingId={setEditingId}
    editTitle={session.title ?? ''}
    setEditTitle={noop}
    handleSaveEdit={noop}
    handleCancelEdit={() => setEditingId(null)}
    toggleParent={(key) => setExpandedParents((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    })}
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

test('indexed child availability survives a live session snapshot without hasChildren and loads only on expansion', async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness editing={false} indexed={{ ...session, hasChildren: true } as Session} />));
  expect(loadChildren).not.toHaveBeenCalled();
  const expand = container.querySelector<HTMLElement>('[aria-label="sessions.sidebar.session.subsessions.expand"]');
  expect(expand).not.toBeNull();
  await act(async () => expand!.click());
  expect(loadChildren).toHaveBeenCalledWith(session.id, '/repo');
  await act(async () => container.querySelector<HTMLElement>('[aria-label="sessions.sidebar.session.subsessions.collapse"]')!.click());
  expect(loadChildren).toHaveBeenCalledTimes(1);
});

test('expanding a partially known subtree still loads the remaining children', async () => {
  root = createRoot(container);
  await act(async () => root.render(<Harness editing={false} children={[
    { session: { ...session, id: 'ses_child', parentID: session.id }, children: [], worktree: null },
  ]} />));
  expect(loadChildren).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLElement>('[aria-label="sessions.sidebar.session.subsessions.expand"]')!.click());
  expect(loadChildren).toHaveBeenCalledWith(session.id, '/repo');
});

test('expansion shows pending state and reports failure so a later expansion can retry', async () => {
  const error = vi.spyOn(toast, 'error').mockImplementation(() => 'error-toast');
  let reject!: (error: Error) => void;
  loadChildren.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  root = createRoot(container);
  await act(async () => root.render(<Harness editing={false} indexed={{ ...session, hasChildren: true } as Session} />));
  await act(async () => container.querySelector<HTMLElement>('[aria-label="sessions.sidebar.session.subsessions.expand"]')!.click());
  expect(container.querySelector('[aria-expanded="true"]')?.getAttribute('aria-busy')).toBe('true');
  await act(async () => reject(new Error('offline')));
  expect(error).toHaveBeenCalledWith('sessions.sidebar.session.subsessions.loadFailed');
  expect(container.querySelector('[aria-expanded="true"]')?.getAttribute('aria-busy')).toBe('false');
  await act(async () => container.querySelector<HTMLElement>('[aria-label="sessions.sidebar.session.subsessions.collapse"]')!.click());
  await act(async () => container.querySelector<HTMLElement>('[aria-label="sessions.sidebar.session.subsessions.expand"]')!.click());
  expect(loadChildren).toHaveBeenCalledTimes(2);
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

test('metadata-only title completion stops text loading while execution remains busy', async () => {
  root = createRoot(container);
  const generating = { ...session, metadata: { openchamber: { titleRefresh: { isGenerating: true } } } } as Session;
  await act(async () => root.render(<Harness editing={false} live={generating} />));
  expect(container.querySelector('.animate-text-shimmer')?.textContent).toBe(session.title);
  const completed = { ...session, metadata: { openchamber: { titleRefresh: {} } } } as Session;
  await act(async () => root.render(<Harness editing={false} live={completed} />));
  expect(container.querySelector('.animate-text-shimmer')).toBeNull();
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(container.querySelector('[aria-label="sessions.sidebar.session.status.active"]')).not.toBeNull();
});
