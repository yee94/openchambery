import { describe, expect, test } from 'bun:test';

import type { MobileProjectHomeItem } from './MobileProjectsHome';
import { filterMobileProjectsForSearch } from './mobileProjectSearch';

const projects: MobileProjectHomeItem[] = [{
  id: 'project-1',
  name: 'OpenChamber',
  path: '/code/openchamber',
  sessionCount: 3,
  expanded: false,
  worktrees: [{
    id: 'main',
    name: 'Main workspace',
    path: '/code/openchamber',
    kind: 'main',
    sessions: [{
      id: 'parent',
      title: 'Parent session',
      children: [{ id: 'child', title: 'Fix mobile search', subtitle: 'Follow-up' }],
    }, {
      id: 'other',
      title: 'Unrelated session',
    }, {
      id: '__show_more__',
      kind: 'pagination',
      title: 'Show more',
    }],
  }, {
    id: 'feature',
    name: 'Feature branch',
    path: '/code/openchamber-feature',
    kind: 'worktree',
    sessions: [{ id: 'feature-session', title: 'Branch work' }],
  }],
}];

describe('filterMobileProjectsForSearch', () => {
  test('preserves the original catalog reference for an empty query', () => {
    expect(filterMobileProjectsForSearch(projects, '   ')).toBe(projects);
  });

  test('returns a project-only result when its name or path matches', () => {
    const result = filterMobileProjectsForSearch(projects, 'openchamber');
    expect(result).toHaveLength(1);
    expect(result[0]?.worktrees).toEqual([]);
  });

  test('keeps parent context for a matching child session and removes unrelated rows', () => {
    const result = filterMobileProjectsForSearch(projects, 'mobile search');
    expect(result).toHaveLength(1);
    expect(result[0]?.worktrees).toHaveLength(1);
    expect(result[0]?.worktrees[0]?.sessions).toEqual([{
      id: 'parent',
      title: 'Parent session',
      children: [{ id: 'child', title: 'Fix mobile search', subtitle: 'Follow-up' }],
    }]);
  });

  test('returns a matching worktree without pagination affordances', () => {
    const result = filterMobileProjectsForSearch(projects, 'feature branch');
    expect(result[0]?.worktrees).toEqual([projects[0]?.worktrees[1]]);
  });

  test('returns no projects when nothing matches', () => {
    expect(filterMobileProjectsForSearch(projects, 'does-not-exist')).toEqual([]);
  });
});
