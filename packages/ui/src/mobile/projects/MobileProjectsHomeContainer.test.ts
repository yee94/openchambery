import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { applyProjectGitProbeResult } from './mobileProjectsHomeContainerState';

const containerSource = readFileSync(new URL('./MobileProjectsHomeContainer.tsx', import.meta.url), 'utf8');

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

describe('MobileProjectsHomeContainer sharing capability', () => {
  test('omits all sharing callbacks when the capability is unavailable', () => {
    expect(containerSource).toContain("import { isSessionSharingAvailable } from '@/sync/session-sharing-availability';");
    expect(containerSource).toContain('const sharingAvailable = isSessionSharingAvailable();');
    expect(containerSource).toContain('onShare: sharingAvailable && !session.share?.url');
    expect(containerSource).toContain('onCopyLink: sharingAvailable && session.share?.url');
    expect(containerSource).toContain('onUnshare: sharingAvailable && session.share?.url');
  });
});
