import React from 'react';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSettingsHydrationPromise } from '@/lib/settingsStartup';
import { discoverGitRepositories } from '@/lib/gitApi';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { planSessionStartupDirectories, runSessionStartupAfterSettingsHydration } from './runSessionStartup';

/** Owns the runtime session index cold-start restore and root-list refresh. */
export const SessionStartupCoordinator: React.FC = () => {
  const startedRef = React.useRef(false);

  React.useLayoutEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const settingsHydration = getSettingsHydrationPromise(getRuntimeKey());
    void runSessionStartupAfterSettingsHydration(
      settingsHydration,
      () => planSessionStartupDirectories(
        useProjectsStore.getState().projects.map((project) => project.path),
        useSessionUIStore.getState().availableWorktreesByProject,
        // Authoritative active path after settings hydration (lastDirectory /
        // active project apply). Missing/unmatched → full-set fallback inside plan.
        { currentDirectory: useDirectoryStore.getState().currentDirectory },
      ),
    );

    // Batch git repo + primary-root discovery for registered projects. Seeds
    // the HTTP discovery caches so per-component checks hit cache instead of
    // fanning out N×GET /api/git/check + N×GET /api/git/primary-root. Runs in
    // parallel with session-index startup; failures are non-blocking (the
    // helper falls back to per-directory requests on demand).
    void Promise.resolve(settingsHydration).then(() => {
      const projectPaths = useProjectsStore.getState().projects.map((project) => project.path);
      if (projectPaths.length === 0) return;
      discoverGitRepositories(projectPaths).catch((error) => {
        console.warn('[SessionStartup] Batch git discovery failed (fallback to per-directory):', error);
      });
    });
  }, []);

  return null;
};
