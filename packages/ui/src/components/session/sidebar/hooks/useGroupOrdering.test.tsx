import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { useGroupOrdering } from './useGroupOrdering';
import { useWorktreeOrderStore } from '@/stores/useWorktreeOrderStore';
import type { SessionGroup } from '../types';

test('shared activity and drag order update desktop worktree slots without moving main or archive', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useWorktreeOrderStore.setState({ orderByProject: {}, pendingProjectIDs: {} });
  const paths = ['/trees/a', '/trees/b', '/trees/c'];
  const catalog = paths.map((path) => ({ path, projectDirectory: '/project', branch: path, label: path }));
  const groups: SessionGroup[] = ['main', ...paths, 'archived'].map((id) => ({
    id, label: id, branch: null, description: null, isMain: id === 'main',
    directory: paths.includes(id) ? id : null, worktree: catalog.find((entry) => entry.path === id) ?? null, sessions: [],
  }));
  const legacy = new Map([['project', ['main', paths[2], paths[1], paths[0], 'archived']]]);
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe() {
    const { getOrderedGroups } = useGroupOrdering(legacy);
    return <>{getOrderedGroups('project', groups).map((group) => <span key={group.id}>{group.id}</span>)}</>;
  }
  const order = () => Array.from(host.querySelectorAll('span'), (element) => element.textContent);
  try {
    act(() => root.render(<Probe />));
    expect(order()).toEqual(['main', paths[2], paths[1], paths[0], 'archived']);
    act(() => useWorktreeOrderStore.getState().setWorktreeOrder('project', '/project', paths));
    act(() => useWorktreeOrderStore.getState().promoteWorktree('project', '/project', paths[1], catalog));
    expect(order()).toEqual(['main', paths[1], paths[0], paths[2], 'archived']);
    act(() => useWorktreeOrderStore.getState().setWorktreeOrder('project', '/project', [paths[2], paths[0], paths[1]]));
    expect(order()).toEqual(['main', paths[2], paths[0], paths[1], 'archived']);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
