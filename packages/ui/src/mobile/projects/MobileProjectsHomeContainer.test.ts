import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

import { applyProjectGitProbeResult } from './mobileProjectsHomeContainerState';

const containerSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'MobileProjectsHomeContainer.tsx'),
  'utf8',
);

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

describe('MobileProjectsHomeContainer session actions', () => {
  test('session sheet wires the shared transcript refresh path', () => {
    expect(containerSource).toContain('onRefreshTranscript: handleRefreshTranscript');
    expect(containerSource).toContain('sync.refreshSessionTranscript');
    expect(containerSource).toContain("t('sessions.sidebar.session.menu.refreshTranscriptSuccess')");
    expect(containerSource).toContain("t('sessions.sidebar.session.menu.refreshTranscriptFailed')");
    expect(containerSource).not.toContain('ensureTranscriptInitial');
  });

  test('project sheet wires edit through MobileProjectEditSurface', () => {
    expect(containerSource).toContain('onEditProject: () => setEditingProjectId(project.id)');
    expect(containerSource).toContain('<MobileProjectEditSurface');
    expect(containerSource).not.toContain('onEditProject: undefined');
  });

  test('header menu callbacks pass through to the presentational home', () => {
    expect(containerSource).toContain('pinnedSessions={model.pinnedSessions}');
    expect(containerSource).toContain('inProgressSessions={model.inProgressSessions}');
    expect(containerSource).toContain('onScanQr={onScanQr}');
    expect(containerSource).toContain('onSwitchInstance={onSwitchInstance}');
  });

  test('home model owns pinned derivation instead of the container', () => {
    expect(containerSource).toContain('pinnedSessions={model.pinnedSessions}');
    expect(containerSource).toContain('inProgressSessions={model.inProgressSessions}');
    expect(containerSource).not.toContain('derivePinnedSessions');
  });
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
