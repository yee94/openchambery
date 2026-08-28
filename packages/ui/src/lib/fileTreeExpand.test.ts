import { describe, expect, test } from 'bun:test';

import {
  collectExpandableDirectoryPaths,
  collectUnexpandedDirectoryPaths,
  FILE_TREE_EXPAND_ALL_MAX_DEPTH,
  getFileTreeDirectoryDepth,
  isFileTreeExpandAllSettled,
  shouldCollapseFileTree,
} from './fileTreeExpand';

describe('fileTreeExpand', () => {
  test('counts directory depth from the workspace root', () => {
    expect(getFileTreeDirectoryDepth('/repo', '/repo')).toBe(0);
    expect(getFileTreeDirectoryDepth('/repo', '/repo/src')).toBe(1);
    expect(getFileTreeDirectoryDepth('/repo', '/repo/src/lib/fileTreeExpand.ts')).toBe(3);
    expect(getFileTreeDirectoryDepth(
      'C:/Users/openchamber',
      'C:/Users/openchamber/packages/ui/src',
    )).toBe(3);
  });

  test('caps expand-all at depth 10 and collapses whenever any path is expanded', () => {
    const root = '/repo';
    const nested = Array.from({ length: FILE_TREE_EXPAND_ALL_MAX_DEPTH + 2 }, (_, index) => {
      const parts = Array.from({ length: index + 1 }, (_, partIndex) => `d${partIndex + 1}`);
      return `${root}/${parts.join('/')}`;
    });
    const childrenByDir: Record<string, Array<{ path: string; type: string }>> = {
      [root]: [{ path: nested[0], type: 'directory' }],
    };
    for (let index = 0; index < nested.length - 1; index += 1) {
      childrenByDir[nested[index]] = [{ path: nested[index + 1], type: 'directory' }];
    }

    const expandable = collectExpandableDirectoryPaths(root, childrenByDir);
    expect(expandable).toHaveLength(FILE_TREE_EXPAND_ALL_MAX_DEPTH);
    expect(expandable).toContain(`${root}/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10`);
    expect(expandable).not.toContain(`${root}/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11`);

    expect(collectUnexpandedDirectoryPaths(expandable, expandable.slice(0, 3))).toEqual(
      expandable.slice(3),
    );
    expect(collectUnexpandedDirectoryPaths(expandable, expandable)).toEqual([]);
    expect(shouldCollapseFileTree([])).toBe(false);
    expect(shouldCollapseFileTree(expandable.slice(0, 1))).toBe(true);
  });

  test('ignores files and directories outside the expand-all depth cap', () => {
    const expandable = collectExpandableDirectoryPaths('/repo', {
      '/repo': [
        { path: '/repo/src', type: 'directory' },
        { path: '/repo/README.md', type: 'file' },
        { path: '/elsewhere', type: 'directory' },
      ],
      '/repo/src': [{ path: '/repo/src/lib', type: 'directory' }],
    });

    expect(expandable).toEqual(['/repo/src', '/repo/src/lib']);
  });

  test('does not treat expand-all as settled while nested directories are still loading', () => {
    const expandable = ['/repo/src', '/repo/src/lib'];
    const expanded = ['/repo/src'];
    expect(isFileTreeExpandAllSettled(expandable, expanded, new Set(['/repo/src']))).toBe(false);
    expect(isFileTreeExpandAllSettled(expandable, expandable, new Set(['/repo/src']))).toBe(false);
    expect(isFileTreeExpandAllSettled(expandable, expandable, new Set(expandable))).toBe(true);
    expect(isFileTreeExpandAllSettled(expandable, [], new Set())).toBe(false);
    expect(isFileTreeExpandAllSettled([], [], new Set())).toBe(true);
  });
});
