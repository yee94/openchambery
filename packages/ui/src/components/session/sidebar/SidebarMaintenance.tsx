import React from 'react';
import { useSessionOrderSync } from '@/hooks/useSessionOrderSync';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useArchivedAutoFolders } from './hooks/useArchivedAutoFolders';
import { useSessionFolderCleanup } from './hooks/useSessionFolderCleanup';
import type { SessionOwnershipIndex } from './sessionOwnership';

export const SidebarMaintenance = React.memo(function SidebarMaintenance({ normalizedProjects, ownership, enabled }: {
  normalizedProjects: { id: string; normalizedPath: string }[];
  ownership: SessionOwnershipIndex;
  enabled: boolean;
}) {
  useSessionOrderSync();
  const fullCatalogSessionIds = useGlobalSessionsStore((state) => state.fullCatalogSessionIds);
  const fullCatalogGeneration = useGlobalSessionsStore((state) => state.fullCatalogGeneration);
  const isSessionsLoading = useSessionUIStore((state) => state.isLoading);
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const cleanupSessions = useSessionFoldersStore((state) => state.cleanupSessions);
  useSessionFolderCleanup({ normalizedProjects, fullCatalogSessionIds, fullCatalogGeneration, isSessionsLoading, cleanupSessions });
  useArchivedAutoFolders({
    normalizedProjects, ownership, enabled, fullCatalogSessionIds, fullCatalogGeneration,
    isSessionsLoading, foldersMap, createFolder, addSessionToFolder, cleanupSessions,
  });
  return null;
});
