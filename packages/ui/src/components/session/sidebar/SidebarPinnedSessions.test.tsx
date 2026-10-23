import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import { SidebarPinnedSessions } from './SidebarPinnedSessions';
import { DraggableSessionRow } from './sessionFolderDnd';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./sessionFolderDnd', () => ({
  DraggableSessionRow: ({ sessionId, children }: { sessionId: string; children: React.ReactNode }) => (
    <div data-session-sortable-row={sessionId}>{children}</div>
  ),
  SessionFolderDndScope: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

test('pinned section does not nest a second sortable around the renderer-owned session row', () => {
  const items = ['a', 'b', 'c'].map((id) => ({
    node: { session: { id, title: id, time: { created: 1 } } as Session, children: [], worktree: null },
    projectId: null, groupDirectory: '/repo', secondaryMeta: null,
  }));
  const html = renderToStaticMarkup(<SidebarPinnedSessions
    items={items} reorderEnabled onSessionsReordered={() => {}}
    currentSessionId={null} editingId={null} openSidebarMenuKey={null}
    renderSessionNode={(node) => (
      <DraggableSessionRow sessionId={node.session.id} sessionTitle={node.session.title ?? ''} sessionDirectory="/repo">
        <button>{node.session.title}</button>
      </DraggableSessionRow>
    )}
  />);
  const container = document.createElement('div');
  container.innerHTML = html;
  expect(container.querySelectorAll('[data-session-sortable-row]')).toHaveLength(3);
  expect(container.querySelector('[data-session-sortable-row] [data-session-sortable-row]')).toBeNull();
});
