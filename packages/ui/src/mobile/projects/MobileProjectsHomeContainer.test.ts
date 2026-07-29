import { describe, expect, test } from 'bun:test';

import { applyProjectGitProbeResult } from './mobileProjectsHomeContainerState';

const projectTarget = (id: string, isGitRepository = false) => ({
  kind: 'project' as const,
  project: {
    id,
    label: id,
    path: `/projects/${id}`,
    worktrees: [],
  },
  isGitRepository,
});

describe('MobileProjectsHomeContainer git probe', () => {
  test('applies a result to the current project action target', () => {
    const current = projectTarget('alpha');

    expect(applyProjectGitProbeResult(current, 'alpha', true)).toEqual({
      ...current,
      isGitRepository: true,
    });
  });

  test('keeps a newer project action target when an older probe resolves', () => {
    const current = projectTarget('beta');

    expect(applyProjectGitProbeResult(current, 'alpha', true)).toBe(current);
  });
});
