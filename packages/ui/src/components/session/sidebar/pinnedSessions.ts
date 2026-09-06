import type { Session } from '@opencode-ai/sdk/v2';

import { getSessionActivityUpdatedAt } from '@/lib/sessionActivity';
import { normalizePath } from '@/lib/pathNormalization';
import type { WorktreeMetadata } from '@/types/worktree';
import type { DirectoryOwner } from './sessionOwnership';

const getSessionCreatedAt = (session: Session): number => {
  const created = session.time?.created;
  return typeof created === 'number' && Number.isFinite(created) ? created : 0;
};

export const derivePinnedSessions = (
  sessions: Session[],
  pinnedSessionIds: ReadonlySet<string>,
): Session[] => {
  return sessions
    .filter((session) => pinnedSessionIds.has(session.id))
    .sort((a, b) => getSessionCreatedAt(b) - getSessionCreatedAt(a));
};

const getSessionParentId = (session: Session): string | null =>
  (session as Session & { parentID?: string | null }).parentID ?? null;

const isSessionArchived = (session: Session): boolean => {
  const archived = session.time?.archived;
  return typeof archived === 'number' && archived > 0;
};

/**
 * Non-pinned home-attention rows: live busy/retry sessions, plus top-level
 * unread sessions (the blue completed-unread marker). Pinned ids stay in the
 * pinned group; archived sessions stay out of this ephemeral set.
 */
export const listInProgressHomeSessions = (
  sessions: Session[],
  pinnedSessionIds: ReadonlySet<string>,
  runningSessionIds: ReadonlySet<string>,
  unseenBySession: Readonly<Record<string, number>>,
): Session[] => {
  const active: Session[] = [];
  for (const session of sessions) {
    if (pinnedSessionIds.has(session.id) || isSessionArchived(session)) continue;
    const running = runningSessionIds.has(session.id);
    const unread = (unseenBySession[session.id] ?? 0) > 0 && !getSessionParentId(session);
    if (!running && !unread) continue;
    active.push(session);
  }
  active.sort((a, b) => getSessionActivityUpdatedAt(b) - getSessionActivityUpdatedAt(a));
  return active;
};

export type TopSectionSecondaryMeta = {
  projectLabel?: string | null;
  branchLabel?: string | null;
};

const sanitizeBranchLabel = (
  branch: string | null | undefined,
  projectLabel: string | null,
): string | null => {
  const trimmed = branch?.trim() || null;
  if (!trimmed || trimmed === 'HEAD') return null;
  if (projectLabel && trimmed === projectLabel) return null;
  return trimmed;
};

/**
 * Hover-card project/branch for the top pinned + in-progress section.
 * Pinned roots are omitted from project groups, so this cannot read the
 * project-tree secondaryMeta index — resolve from ownership instead.
 */
export const resolveTopSectionSecondaryMeta = (args: {
  projectLabel: string | null;
  owner: DirectoryOwner | undefined;
  sessionWorktree: Pick<WorktreeMetadata, 'branch' | 'path'> | null | undefined;
  worktrees: readonly Pick<WorktreeMetadata, 'branch' | 'path'>[];
  projectRootBranch: string | null | undefined;
  isVSCode: boolean;
}): TopSectionSecondaryMeta | null => {
  const projectLabel = args.projectLabel?.trim() || null;
  if (args.isVSCode) {
    return projectLabel ? { projectLabel, branchLabel: null } : null;
  }

  let branch: string | null | undefined;
  if (args.owner?.kind === 'worktree') {
    const matched = args.worktrees.find(
      (worktree) => normalizePath(worktree.path) === args.owner?.scopeDirectory,
    );
    branch = matched?.branch ?? args.sessionWorktree?.branch;
  } else {
    branch = args.projectRootBranch ?? args.sessionWorktree?.branch;
  }

  const branchLabel = sanitizeBranchLabel(branch, projectLabel);
  if (!projectLabel && !branchLabel) return null;
  return { projectLabel, branchLabel };
};
