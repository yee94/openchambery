import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { getDeferredSafeStorage } from './utils/safeStorage';
import { createInstanceScopedStorageAdapter } from '@/lib/instanceScopedStorage';
import { isRuntimeInstanceChange, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { createUuid } from '@/lib/uuid';

// --- Types ---

export interface SessionFolder {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt: number;
  /** If set, this folder is a sub-folder of the parent folder with this id */
  parentId?: string | null;
}

export type SessionFoldersMap = Record<string, SessionFolder[]>;
export type SessionOrderMap = Record<string, string[]>;
export type SessionOrderActivityMap = Record<string, Record<string, number>>;

export const sessionOrderActivityMatches = (
  current: Readonly<Record<string, number>>,
  saved: Readonly<Record<string, number>> | undefined,
): boolean => {
  if (!saved) return false;
  const currentIds = Object.keys(current);
  const savedIds = Object.keys(saved);
  return currentIds.length === savedIds.length
    && currentIds.every((id) => saved[id] === current[id]);
};

interface SessionFoldersState {
  foldersMap: SessionFoldersMap;
  collapsedFolderIds: Set<string>;
  sessionOrderByScope: SessionOrderMap;
  sessionOrderActivityByScope: SessionOrderActivityMap;
}

interface SessionFoldersActions {
  getFoldersForScope: (scopeKey: string) => SessionFolder[];
  createFolder: (scopeKey: string, name: string, parentId?: string | null) => SessionFolder;
  renameFolder: (scopeKey: string, folderId: string, name: string) => void;
  deleteFolder: (scopeKey: string, folderId: string) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]) => void;
  removeSessionFromFolder: (scopeKey: string, sessionId: string) => void;
  removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]) => void;
  toggleFolderCollapse: (folderId: string) => void;
  cleanupSessions: (scopeKey: string, existingSessionIds: Set<string>) => void;
  getSessionFolderId: (scopeKey: string, sessionId: string) => string | null;
  reorderSessions: (scopeKey: string, sessionIds: string[], activeSessionId: string, overSessionId: string, activityBySessionId: Readonly<Record<string, number>>) => void;
}

type SessionFoldersStore = SessionFoldersState & SessionFoldersActions;

// --- Storage ---

const FOLDERS_STORAGE_KEY = 'oc.sessions.folders';
const COLLAPSED_STORAGE_KEY = 'oc.sessions.folderCollapse';
const SESSION_ORDER_STORAGE_KEY = 'oc.sessions.order';
const SESSION_ORDER_ACTIVITY_STORAGE_KEY = 'oc.sessions.orderActivity';
const SESSION_FOLDERS_API_PATH = '/api/session-folders';
const DISK_WRITE_DEBOUNCE_MS = 250;
const ARCHIVED_SCOPE_PREFIX = '__archived__:';

const safeStorage = createInstanceScopedStorageAdapter(getDeferredSafeStorage());
let diskWriteTimer: ReturnType<typeof setTimeout> | null = null;
let diskHydrated = false;
let diskHydrationInFlight = false;
let diskHydrationGeneration = 0;
let persistFoldersTimer: ReturnType<typeof setTimeout> | undefined;
let persistCollapsedTimer: ReturnType<typeof setTimeout> | undefined;
let pendingFoldersMap: SessionFoldersMap | null = null;
let pendingCollapsedIds: Set<string> | null = null;

const isVSCodeWebview = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  if (isVSCodeRuntime()) {
    return true;
  }

  return (window as { __VSCODE_CONFIG__?: unknown }).__VSCODE_CONFIG__ !== undefined;
};

const schedulePersistToDisk = (foldersMap: SessionFoldersMap, collapsedFolderIds: Set<string>): void => {
  if (typeof window === 'undefined') {
    return;
  }

  if (isVSCodeWebview()) {
    return;
  }

  if (diskWriteTimer) {
    clearTimeout(diskWriteTimer);
  }

  const foldersSnapshot = JSON.parse(JSON.stringify(foldersMap)) as SessionFoldersMap;
  const collapsedSnapshot = Array.from(collapsedFolderIds);

  diskWriteTimer = setTimeout(() => {
    diskWriteTimer = null;
    const payload = {
      version: 1,
      foldersMap: foldersSnapshot,
      collapsedFolderIds: collapsedSnapshot,
      updatedAt: Date.now(),
    };
    void runtimeFetch(SESSION_FOLDERS_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => { /* best-effort */ });
  }, DISK_WRITE_DEBOUNCE_MS);
};

const readPersistedFolders = (): SessionFoldersMap => {
  try {
    const raw = safeStorage.getItem(FOLDERS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: SessionFoldersMap = {};
    for (const [scopeKey, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) {
        continue;
      }
      const folders: SessionFolder[] = [];
      for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const candidate = entry as Record<string, unknown>;
        const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
        const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
        const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : 0;
        if (!id || !name) continue;
        const sessionIds = Array.isArray(candidate.sessionIds)
          ? (candidate.sessionIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          : [];
        const parentId = typeof candidate.parentId === 'string' ? candidate.parentId : null;
        folders.push({ id, name, sessionIds, createdAt, parentId });
      }
      if (folders.length > 0) {
        result[scopeKey] = folders;
      }
    }
    return result;
  } catch {
    return {};
  }
};

const readPersistedCollapsed = (): Set<string> => {
  try {
    const raw = safeStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
};

const readPersistedSessionOrder = (): SessionOrderMap => {
  try {
    const raw = safeStorage.getItem(SESSION_ORDER_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([scopeKey, value]) => {
        if (!Array.isArray(value)) return [];
        const sessionIds = value.filter((id): id is string => typeof id === 'string' && id.length > 0);
        return sessionIds.length > 0 ? [[scopeKey, sessionIds]] : [];
      }),
    );
  } catch {
    return {};
  }
};

const readPersistedSessionOrderActivity = (): SessionOrderActivityMap => {
  try {
    const raw = safeStorage.getItem(SESSION_ORDER_ACTIVITY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([scopeKey, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const activity = Object.fromEntries(Object.entries(value).flatMap(([id, updatedAt]) => (
        typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? [[id, updatedAt]] : []
      )));
      return Object.keys(activity).length > 0 ? [[scopeKey, activity]] : [];
    }));
  } catch {
    return {};
  }
};

const persistSessionOrderState = (
  sessionOrderByScope: SessionOrderMap,
  sessionOrderActivityByScope: SessionOrderActivityMap,
): void => {
  try {
    safeStorage.setItem(SESSION_ORDER_STORAGE_KEY, JSON.stringify(sessionOrderByScope));
    safeStorage.setItem(SESSION_ORDER_ACTIVITY_STORAGE_KEY, JSON.stringify(sessionOrderActivityByScope));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
};

const persistFolders = (foldersMap: SessionFoldersMap): void => {
  pendingFoldersMap = foldersMap;
  clearTimeout(persistFoldersTimer);
  persistFoldersTimer = setTimeout(() => {
    try {
      safeStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(foldersMap));
      pendingFoldersMap = null;
    } catch {
      // ignored
    }
  }, 300);
};

const persistCollapsed = (collapsedFolderIds: Set<string>): void => {
  pendingCollapsedIds = collapsedFolderIds;
  clearTimeout(persistCollapsedTimer);
  persistCollapsedTimer = setTimeout(() => {
    try {
      safeStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(Array.from(collapsedFolderIds)));
      pendingCollapsedIds = null;
    } catch {
      // ignored
    }
  }, 300);
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (pendingFoldersMap !== null) {
      clearTimeout(persistFoldersTimer);
      try {
        safeStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(pendingFoldersMap));
      } catch { /* ignored */ }
      pendingFoldersMap = null;
    }
    if (pendingCollapsedIds !== null) {
      clearTimeout(persistCollapsedTimer);
      try {
        safeStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(Array.from(pendingCollapsedIds)));
      } catch { /* ignored */ }
      pendingCollapsedIds = null;
    }
  });
}

const persistState = (foldersMap: SessionFoldersMap, collapsedFolderIds: Set<string>): void => {
  persistFolders(foldersMap);
  persistCollapsed(collapsedFolderIds);
  schedulePersistToDisk(foldersMap, collapsedFolderIds);
};

const createFolderId = (): string => {
  return createUuid();
};

const syncCollapsedAfterFolderCleanup = (
  prevFolders: SessionFolder[],
  nextFolders: SessionFolder[],
  collapsedFolderIds: Set<string>,
): Set<string> | null => {
  const nextFolderIds = new Set(nextFolders.map((folder) => folder.id));
  let nextCollapsed: Set<string> | null = null;

  for (const folder of prevFolders) {
    if (!nextFolderIds.has(folder.id) && collapsedFolderIds.has(folder.id)) {
      if (!nextCollapsed) {
        nextCollapsed = new Set(collapsedFolderIds);
      }
      nextCollapsed.delete(folder.id);
    }
  }

  return nextCollapsed;
};

const pruneEmptyArchivedFolders = (scopeKey: string, folders: SessionFolder[]): SessionFolder[] => {
  if (!scopeKey.startsWith(ARCHIVED_SCOPE_PREFIX)) {
    return folders;
  }

  return folders.filter((folder) => folder.sessionIds.length > 0);
};

// --- Store ---

export const useSessionFoldersStore = create<SessionFoldersStore>()(
  devtools(
    (set, get) => ({
      foldersMap: readPersistedFolders(),
      collapsedFolderIds: readPersistedCollapsed(),
      sessionOrderByScope: readPersistedSessionOrder(),
      sessionOrderActivityByScope: readPersistedSessionOrderActivity(),

      getFoldersForScope: (scopeKey: string): SessionFolder[] => {
        if (!scopeKey) return [];
        return get().foldersMap[scopeKey] ?? [];
      },

      createFolder: (scopeKey: string, name: string, parentId?: string | null): SessionFolder => {
        const trimmed = name.trim() || 'New folder';
        const folder: SessionFolder = {
          id: createFolderId(),
          name: trimmed,
          sessionIds: [],
          createdAt: Date.now(),
          parentId: parentId ?? null,
        };
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey] ?? [];
        const nextMap: SessionFoldersMap = {
          ...current,
          [scopeKey]: [...scopeFolders, folder],
        };
        set({ foldersMap: nextMap });
        persistState(nextMap, get().collapsedFolderIds);
        return folder;
      },

      renameFolder: (scopeKey: string, folderId: string, name: string): void => {
        const trimmed = name.trim();
        if (!trimmed || !scopeKey) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;
        const nextFolders = scopeFolders.map((folder) =>
          folder.id === folderId ? { ...folder, name: trimmed } : folder,
        );
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        set({ foldersMap: nextMap });
        persistState(nextMap, get().collapsedFolderIds);
      },

      deleteFolder: (scopeKey: string, folderId: string): void => {
        if (!scopeKey) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;
        // Also delete all sub-folders of this folder
        const idsToDelete = new Set<string>([folderId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const f of scopeFolders) {
            if (f.parentId && idsToDelete.has(f.parentId) && !idsToDelete.has(f.id)) {
              idsToDelete.add(f.id);
              changed = true;
            }
          }
        }
        const nextFolders = scopeFolders.filter((folder) => !idsToDelete.has(folder.id));
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        set({ foldersMap: nextMap });
        persistState(nextMap, get().collapsedFolderIds);

        // Clean up collapsed state for all deleted folders
        const collapsed = get().collapsedFolderIds;
        const hasStale = Array.from(idsToDelete).some((id) => collapsed.has(id));
        if (hasStale) {
          const nextCollapsed = new Set(collapsed);
          idsToDelete.forEach((id) => nextCollapsed.delete(id));
          set({ collapsedFolderIds: nextCollapsed });
          persistState(nextMap, nextCollapsed);
        }
      },

      addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string): void => {
        if (!scopeKey || !folderId || !sessionId) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;

        const targetFolder = scopeFolders.find((folder) => folder.id === folderId);
        if (!targetFolder) return;

        const sessionFolderCount = scopeFolders.reduce(
          (count, folder) => count + (folder.sessionIds.includes(sessionId) ? 1 : 0),
          0,
        );
        if (targetFolder.sessionIds.includes(sessionId) && sessionFolderCount === 1) {
          return;
        }

        // Remove session from any existing folder first, then add to target
        const nextFolders = scopeFolders.map((folder) => {
          const withoutSession = folder.sessionIds.filter((id) => id !== sessionId);
          if (folder.id === folderId) {
            return { ...folder, sessionIds: [...withoutSession, sessionId] };
          }
          if (withoutSession.length !== folder.sessionIds.length) {
            return { ...folder, sessionIds: withoutSession };
          }
          return folder;
        });

        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeFolders, nextFolders, get().collapsedFolderIds);

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      },

      addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]): void => {
        if (!scopeKey || !folderId || sessionIds.length === 0) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;

        const idSet = new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0));
        if (idSet.size === 0) return;

        const targetFolder = scopeFolders.find((folder) => folder.id === folderId);
        if (!targetFolder) return;

        let changed = false;
        for (const folder of scopeFolders) {
          for (const id of idSet) {
            if (!folder.sessionIds.includes(id)) continue;
            if (folder.id !== folderId || !targetFolder.sessionIds.includes(id)) {
              changed = true;
              break;
            }
          }
          if (changed) break;
        }
        if (!changed) {
          for (const id of idSet) {
            if (!targetFolder.sessionIds.includes(id)) {
              changed = true;
              break;
            }
          }
        }
        if (!changed) return;

        const nextFolders = scopeFolders.map((folder) => {
          const withoutSessions = folder.sessionIds.filter((id) => !idSet.has(id));
          if (folder.id === folderId) {
            return { ...folder, sessionIds: [...withoutSessions, ...idSet] };
          }
          if (withoutSessions.length !== folder.sessionIds.length) {
            return { ...folder, sessionIds: withoutSessions };
          }
          return folder;
        });

        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeFolders, nextFolders, get().collapsedFolderIds);

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      },

      removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]): void => {
        if (!scopeKey || sessionIds.length === 0) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;

        const idSet = new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0));
        if (idSet.size === 0) return;

        let changed = false;
        const nextFolders = scopeFolders.map((folder) => {
          const filtered = folder.sessionIds.filter((id) => !idSet.has(id));
          if (filtered.length !== folder.sessionIds.length) {
            changed = true;
            return { ...folder, sessionIds: filtered };
          }
          return folder;
        });

        if (!changed) return;
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeFolders, nextFolders, get().collapsedFolderIds);

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      },

      removeSessionFromFolder: (scopeKey: string, sessionId: string): void => {
        if (!scopeKey || !sessionId) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;

        let changed = false;
        const nextFolders = scopeFolders.map((folder) => {
          const filtered = folder.sessionIds.filter((id) => id !== sessionId);
          if (filtered.length !== folder.sessionIds.length) {
            changed = true;
            return { ...folder, sessionIds: filtered };
          }
          return folder;
        });

        if (!changed) return;
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeFolders, nextFolders, get().collapsedFolderIds);

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      },

      toggleFolderCollapse: (folderId: string): void => {
        const collapsed = get().collapsedFolderIds;
        const next = new Set(collapsed);
        if (next.has(folderId)) {
          next.delete(folderId);
        } else {
          next.add(folderId);
        }
        set({ collapsedFolderIds: next });
        persistState(get().foldersMap, next);
      },

      cleanupSessions: (scopeKey: string, existingSessionIds: Set<string>): void => {
        if (!scopeKey) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        const currentOrder = get().sessionOrderByScope[scopeKey] ?? [];
        const currentActivity = get().sessionOrderActivityByScope[scopeKey] ?? {};
        if ((!scopeFolders || scopeFolders.length === 0) && currentOrder.length === 0 && Object.keys(currentActivity).length === 0) return;

        let changed = false;
        const filteredFolders = (scopeFolders ?? []).map((folder) => {
          const filtered = folder.sessionIds.filter((id) => existingSessionIds.has(id));
          if (filtered.length !== folder.sessionIds.length) {
            changed = true;
            return { ...folder, sessionIds: filtered };
          }
          return folder;
        });

        const nextFolders = pruneEmptyArchivedFolders(scopeKey, filteredFolders);
        if (nextFolders.length !== filteredFolders.length) {
          changed = true;
        }

        const nextOrder = currentOrder.filter((id) => existingSessionIds.has(id));
        const orderChanged = nextOrder.length !== currentOrder.length;
        const activityChanged = Object.keys(currentActivity).some((id) => !existingSessionIds.has(id));
        if (!changed && !orderChanged && !activityChanged) return;
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeFolders ?? [], nextFolders, get().collapsedFolderIds);
        const nextSessionOrderByScope = orderChanged
          ? { ...get().sessionOrderByScope, [scopeKey]: nextOrder }
          : get().sessionOrderByScope;
        const nextSessionOrderActivityByScope = (orderChanged || activityChanged)
          ? Object.fromEntries(Object.entries(get().sessionOrderActivityByScope).filter(([key]) => key !== scopeKey))
          : get().sessionOrderActivityByScope;

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed, sessionOrderByScope: nextSessionOrderByScope, sessionOrderActivityByScope: nextSessionOrderActivityByScope }
          : { foldersMap: nextMap, sessionOrderByScope: nextSessionOrderByScope, sessionOrderActivityByScope: nextSessionOrderActivityByScope });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
        persistSessionOrderState(nextSessionOrderByScope, nextSessionOrderActivityByScope);
      },

      getSessionFolderId: (scopeKey: string, sessionId: string): string | null => {
        if (!scopeKey || !sessionId) return null;
        const scopeFolders = get().foldersMap[scopeKey];
        if (!scopeFolders) return null;
        for (const folder of scopeFolders) {
          if (folder.sessionIds.includes(sessionId)) {
            return folder.id;
          }
        }
        return null;
      },

      reorderSessions: (scopeKey, sessionIds, activeSessionId, overSessionId, activityBySessionId): void => {
        if (!scopeKey || activeSessionId === overSessionId) return;
        const visibleIds = Array.from(new Set(sessionIds));
        const activeIndex = visibleIds.indexOf(activeSessionId);
        const overIndex = visibleIds.indexOf(overSessionId);
        if (activeIndex === -1 || overIndex === -1) return;

        const currentOrder = get().sessionOrderByScope[scopeKey] ?? [];
        const currentActivity = get().sessionOrderActivityByScope[scopeKey];
        const currentOrderIsActive = sessionOrderActivityMatches(activityBySessionId, currentActivity);
        const orderedVisibleIds = currentOrderIsActive
          ? [
              ...currentOrder.filter((id) => visibleIds.includes(id)),
              ...visibleIds.filter((id) => !currentOrder.includes(id)),
            ]
          : visibleIds;
        const fromIndex = orderedVisibleIds.indexOf(activeSessionId);
        const toIndex = orderedVisibleIds.indexOf(overSessionId);
        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;

        const nextOrder = [...orderedVisibleIds];
        nextOrder.splice(fromIndex, 1);
        nextOrder.splice(toIndex, 0, activeSessionId);
        const visibleIdSet = new Set(visibleIds);
        const hiddenOrder = currentOrderIsActive
          ? currentOrder.filter((id) => !visibleIdSet.has(id))
          : [];
        const nextSessionOrderByScope = { ...get().sessionOrderByScope, [scopeKey]: [...nextOrder, ...hiddenOrder] };
        const nextSessionOrderActivityByScope = {
          ...get().sessionOrderActivityByScope,
          [scopeKey]: { ...activityBySessionId },
        };
        set({ sessionOrderByScope: nextSessionOrderByScope, sessionOrderActivityByScope: nextSessionOrderActivityByScope });
        persistSessionOrderState(nextSessionOrderByScope, nextSessionOrderActivityByScope);
      },
    }),
    { name: 'session-folders-store' },
  ),
);

const hydrateSessionFoldersFromDisk = async (): Promise<void> => {
  if (diskHydrated || diskHydrationInFlight || typeof window === 'undefined') {
    return;
  }

  if (isVSCodeWebview()) {
    diskHydrated = true;
    return;
  }

  diskHydrationInFlight = true;
  const generation = diskHydrationGeneration;

  try {
    const response = await runtimeFetch(SESSION_FOLDERS_API_PATH).catch(() => null);
    if (generation !== diskHydrationGeneration) {
      return;
    }
    if (!response || !response.ok) {
      return;
    }

    const parsed = await response.json().catch(() => null) as {
      foldersMap?: SessionFoldersMap;
      collapsedFolderIds?: string[];
    } | null;

    if (!parsed) {
      return;
    }

    const diskFolders = parsed.foldersMap && typeof parsed.foldersMap === 'object'
      ? parsed.foldersMap
      : {};
    const diskCollapsed = Array.isArray(parsed.collapsedFolderIds)
      ? new Set(parsed.collapsedFolderIds.filter((value): value is string => typeof value === 'string'))
      : new Set<string>();

    if (generation !== diskHydrationGeneration) {
      return;
    }

    const hasDiskData = Object.keys(diskFolders).length > 0 || diskCollapsed.size > 0;
    if (!hasDiskData) {
      return;
    }

    useSessionFoldersStore.setState({
      foldersMap: diskFolders,
      collapsedFolderIds: diskCollapsed,
    });

    persistFolders(diskFolders);
    persistCollapsed(diskCollapsed);
  } catch {
    // ignored
  } finally {
    if (generation === diskHydrationGeneration) {
      diskHydrationInFlight = false;
      diskHydrated = true;
    }
  }
};

const bootstrapSessionFoldersDiskHydration = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  void hydrateSessionFoldersFromDisk();
};

const resetSessionFoldersForInstanceSwitch = (): void => {
  diskHydrationGeneration += 1;
  diskHydrated = false;
  diskHydrationInFlight = false;
  pendingFoldersMap = null;
  pendingCollapsedIds = null;
  if (persistFoldersTimer) {
    clearTimeout(persistFoldersTimer);
    persistFoldersTimer = undefined;
  }
  if (persistCollapsedTimer) {
    clearTimeout(persistCollapsedTimer);
    persistCollapsedTimer = undefined;
  }
  useSessionFoldersStore.setState({
    foldersMap: readPersistedFolders(),
    collapsedFolderIds: readPersistedCollapsed(),
    sessionOrderByScope: readPersistedSessionOrder(),
    sessionOrderActivityByScope: readPersistedSessionOrderActivity(),
  });
  void hydrateSessionFoldersFromDisk();
};

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged((detail) => {
    if (!isRuntimeInstanceChange(detail)) return;
    resetSessionFoldersForInstanceSwitch();
  });
}

bootstrapSessionFoldersDiskHydration();
