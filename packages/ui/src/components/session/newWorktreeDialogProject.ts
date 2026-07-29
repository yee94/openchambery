import type { ProjectEntry } from '@/lib/api/types';

export const resolveWorktreeDialogProject = (
  projects: ProjectEntry[],
  activeProjectId: string | null,
  projectId?: string | null,
): ProjectEntry | null => {
  const resolvedProjectId = projectId ?? activeProjectId;
  return resolvedProjectId
    ? projects.find((project) => project.id === resolvedProjectId) ?? null
    : null;
};
