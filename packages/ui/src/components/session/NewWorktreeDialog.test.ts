import { describe, expect, test } from 'bun:test';

import { resolveWorktreeDialogProject } from './newWorktreeDialogProject';

const projects = [
  { id: 'alpha', path: '/projects/alpha' },
  { id: 'beta', path: '/projects/beta' },
];

describe('NewWorktreeDialog project resolution', () => {
  test('resolves an explicit project independently of the active project', () => {
    expect(resolveWorktreeDialogProject(projects, 'alpha', 'beta')).toBe(projects[1]);
  });

  test('uses the active project when the explicit project is omitted', () => {
    expect(resolveWorktreeDialogProject(projects, 'alpha')).toBe(projects[0]);
  });

  test('returns no project for an unavailable explicit project', () => {
    expect(resolveWorktreeDialogProject(projects, 'alpha', 'missing')).toBeNull();
  });
});
