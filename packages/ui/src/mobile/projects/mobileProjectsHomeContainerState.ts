import type { Session } from '@opencode-ai/sdk/v2/client';

import type { ProjectMeta } from './useMobileProjectsHomeModel';

export type ActionTargetState =
  | { kind: 'session'; session: Session }
  | { kind: 'project'; project: ProjectMeta; isGitRepository: boolean }
  | { kind: 'worktree'; project: ProjectMeta; worktreePath: string; worktreeName: string };

export const applyProjectGitProbeResult = (
  current: ActionTargetState | null,
  projectId: string,
  isGitRepository: boolean,
): ActionTargetState | null => (
  current?.kind === 'project' && current.project.id === projectId
    ? { ...current, isGitRepository }
    : current
);
