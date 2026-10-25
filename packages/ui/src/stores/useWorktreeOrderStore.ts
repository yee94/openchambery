import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { readInstanceScopedItem } from '@/lib/instanceScopedStorage';
import { normalizePath } from '@/lib/pathNormalization';
import type { WorktreeMetadata } from '@/types/worktree';

type RuntimeOrders = { orderByProject: Record<string, string[]>; pendingProjectIDs: Record<string, true> };
type DeferredServerOrder = { orderedPaths: string[]; revision: number };
type WorktreeOrderWriter = (projectID: string, projectDirectory: string, orderedPaths: string[]) => void;

let writer: WorktreeOrderWriter | null = null;

export const registerWorktreeOrderWriter = (next: WorktreeOrderWriter): (() => void) => {
  const previous = writer;
  writer = next;
  return () => { if (writer === next) writer = previous; };
};

const emptyRuntimeOrders = (): RuntimeOrders => ({ orderByProject: {}, pendingProjectIDs: {} });
const samePaths = (left: string[] | undefined, right: string[]): boolean => Boolean(left && left.length === right.length && left.every((path, index) => path === right[index]));

type WorktreeOrderStore = {
  runtimeIdentity: string;
  orderByProject: Record<string, string[]>;
  serverRevisionByProject: Record<string, number>;
  deferredServerOrderByProject: Record<string, DeferredServerOrder>;
  pendingProjectIDs: Record<string, true>;
  runtimeOrdersByIdentity: Record<string, RuntimeOrders>;
  activateWorktreeOrderRuntime: (identity: string) => void;
  setWorktreeOrder: (projectId: string, projectDirectory: string, orderedPaths: string[]) => void;
  promoteWorktree: (projectId: string, projectDirectory: string, directory: string | null, worktrees: WorktreeMetadata[]) => void;
  markPendingWorktreeOrder: (projectId: string) => void;
  applyServerWorktreeOrder: (projectId: string, orderedPaths: string[], revision: number) => void;
  setServerRevision: (projectId: string, revision: number) => void;
  resolvePendingWorktreeOrder: (projectId: string, revision: number) => void;
  resetServerWorktreeOrders: () => void;
  hasPendingWorktreeOrder: (projectId: string) => boolean;
};

const initialRuntimeIdentity = getRuntimeTransportIdentity();

export const useWorktreeOrderStore = create<WorktreeOrderStore>()(persist(
  (set, get) => ({
    runtimeIdentity: initialRuntimeIdentity,
    ...emptyRuntimeOrders(),
    serverRevisionByProject: {},
    deferredServerOrderByProject: {},
    runtimeOrdersByIdentity: { [initialRuntimeIdentity]: emptyRuntimeOrders() },
    activateWorktreeOrderRuntime: (identity) => set((state) => {
      if (state.runtimeIdentity === identity) return state;
      const next = state.runtimeOrdersByIdentity[identity] ?? emptyRuntimeOrders();
      return { runtimeIdentity: identity, orderByProject: next.orderByProject, pendingProjectIDs: next.pendingProjectIDs, serverRevisionByProject: {}, deferredServerOrderByProject: {}, runtimeOrdersByIdentity: state.runtimeOrdersByIdentity[identity] ? state.runtimeOrdersByIdentity : { ...state.runtimeOrdersByIdentity, [identity]: next } };
    }),
    setWorktreeOrder: (projectID, projectDirectory, orderedPaths) => {
      let shouldWrite = false;
      set((state) => {
        const same = samePaths(state.orderByProject[projectID], orderedPaths);
        const pendingProjectIDs: Record<string, true> = state.pendingProjectIDs[projectID] ? state.pendingProjectIDs : { ...state.pendingProjectIDs, [projectID]: true };
        shouldWrite = !same || pendingProjectIDs !== state.pendingProjectIDs;
        if (!shouldWrite) return state;
        const orderByProject = same ? state.orderByProject : { ...state.orderByProject, [projectID]: orderedPaths };
        const runtimeOrders = { orderByProject, pendingProjectIDs };
        return { orderByProject, pendingProjectIDs, runtimeOrdersByIdentity: { ...state.runtimeOrdersByIdentity, [state.runtimeIdentity]: runtimeOrders } };
      });
      if (shouldWrite) writer?.(projectID, projectDirectory, orderedPaths);
    },
    promoteWorktree: (projectID, projectDirectory, directory, worktrees) => {
      const target = normalizePath(directory);
      const root = normalizePath(projectDirectory);
      if (!target || target === root) return;
      let matched: string | null = null;
      const paths: string[] = [];
      for (const worktree of worktrees) {
        const path = normalizePath(worktree.path);
        if (!path || path === root) continue;
        paths.push(path);
        if ((target === path || target.startsWith(`${path}/`)) && (!matched || path.length > matched.length)) matched = path;
      }
      if (!matched) return;
      let preferred = get().orderByProject[projectID];
      if (!preferred) {
        try {
          const legacy = JSON.parse(readInstanceScopedItem('oc.sessions.groupOrder') ?? '{}')?.[projectID];
          if (Array.isArray(legacy)) preferred = legacy
            .filter((id): id is string => typeof id === 'string' && id.startsWith('worktree:'))
            .map((id) => id.slice('worktree:'.length));
        } catch { /* Malformed legacy preferences fall back to catalog order. */ }
      }
      const current = [...new Set([...(preferred ?? []), ...paths].map(normalizePath).filter((path): path is string => Boolean(path) && path !== root))];
      if (normalizePath(get().orderByProject[projectID]?.[0]) === matched) return;
      get().setWorktreeOrder(projectID, projectDirectory, [matched, ...current.filter((path) => path !== matched)]);
    },
    markPendingWorktreeOrder: (projectID) => set((state) => {
      if (state.pendingProjectIDs[projectID]) return state;
      const pendingProjectIDs = { ...state.pendingProjectIDs, [projectID]: true as const };
      return {
        pendingProjectIDs,
        runtimeOrdersByIdentity: {
          ...state.runtimeOrdersByIdentity,
          [state.runtimeIdentity]: { orderByProject: state.orderByProject, pendingProjectIDs },
        },
      };
    }),
    applyServerWorktreeOrder: (projectID, orderedPaths, revision) => set((state) => {
      const currentRevision = state.serverRevisionByProject[projectID];
      if (currentRevision !== undefined && revision <= currentRevision) return state;
      const serverRevisionByProject = { ...state.serverRevisionByProject, [projectID]: revision };
      if (state.pendingProjectIDs[projectID]) return { serverRevisionByProject, deferredServerOrderByProject: { ...state.deferredServerOrderByProject, [projectID]: { orderedPaths, revision } } };
      if (samePaths(state.orderByProject[projectID], orderedPaths)) return { serverRevisionByProject };
      const orderByProject = { ...state.orderByProject, [projectID]: orderedPaths };
      return { orderByProject, serverRevisionByProject, runtimeOrdersByIdentity: { ...state.runtimeOrdersByIdentity, [state.runtimeIdentity]: { orderByProject, pendingProjectIDs: state.pendingProjectIDs } } };
    }),
    setServerRevision: (projectID, revision) => set((state) => {
      const currentRevision = state.serverRevisionByProject[projectID];
      return currentRevision !== undefined && revision <= currentRevision ? state : { serverRevisionByProject: { ...state.serverRevisionByProject, [projectID]: revision } };
    }),
    resolvePendingWorktreeOrder: (projectID, revision) => set((state) => {
      const currentRevision = state.serverRevisionByProject[projectID];
      const deferred = state.deferredServerOrderByProject[projectID];
      const highestRevision = Math.max(currentRevision ?? 0, revision, deferred?.revision ?? 0);
      const serverRevisionByProject = currentRevision === highestRevision ? state.serverRevisionByProject : { ...state.serverRevisionByProject, [projectID]: highestRevision };
      const deferredServerOrderByProject = deferred ? (() => {
        const next = { ...state.deferredServerOrderByProject };
        delete next[projectID];
        return next;
      })() : state.deferredServerOrderByProject;
      if (!state.pendingProjectIDs[projectID]) return serverRevisionByProject === state.serverRevisionByProject && deferredServerOrderByProject === state.deferredServerOrderByProject ? state : { serverRevisionByProject, deferredServerOrderByProject };
      const pendingProjectIDs = { ...state.pendingProjectIDs };
      delete pendingProjectIDs[projectID];
      const shouldApplyDeferred = Boolean(deferred && deferred.revision > revision);
      const orderByProject = shouldApplyDeferred && !samePaths(state.orderByProject[projectID], deferred.orderedPaths) ? { ...state.orderByProject, [projectID]: deferred.orderedPaths } : state.orderByProject;
      return { pendingProjectIDs, orderByProject, serverRevisionByProject, deferredServerOrderByProject, runtimeOrdersByIdentity: { ...state.runtimeOrdersByIdentity, [state.runtimeIdentity]: { orderByProject, pendingProjectIDs } } };
    }),
    resetServerWorktreeOrders: () => set((state) => Object.keys(state.serverRevisionByProject).length === 0 && Object.keys(state.deferredServerOrderByProject).length === 0 ? state : { serverRevisionByProject: {}, deferredServerOrderByProject: {} }),
    hasPendingWorktreeOrder: (projectID) => Boolean(get().pendingProjectIDs[projectID]),
  }),
  {
    name: 'mobile-worktree-order',
    version: 2,
    partialize: (state) => ({ runtimeOrdersByIdentity: state.runtimeOrdersByIdentity }),
    migrate: (persisted) => {
      const value = persisted as { runtimeOrdersByIdentity?: Record<string, RuntimeOrders>; orderByProject?: Record<string, string[]>; pendingProjectIDs?: Record<string, true> };
      if (value.runtimeOrdersByIdentity) return { runtimeOrdersByIdentity: value.runtimeOrdersByIdentity };
      return { runtimeOrdersByIdentity: { [initialRuntimeIdentity]: { orderByProject: value.orderByProject ?? {}, pendingProjectIDs: value.pendingProjectIDs ?? {} } } };
    },
    merge: (persisted, current) => {
      const saved = persisted as { runtimeOrdersByIdentity?: Record<string, RuntimeOrders> };
      const runtimeOrdersByIdentity = saved.runtimeOrdersByIdentity ?? current.runtimeOrdersByIdentity;
      const active = runtimeOrdersByIdentity[current.runtimeIdentity] ?? emptyRuntimeOrders();
      return { ...current, runtimeOrdersByIdentity, orderByProject: active.orderByProject, pendingProjectIDs: active.pendingProjectIDs };
    },
  },
));

const normalizeWorktreePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');

export const orderWorktrees = (orderedPaths: string[] | undefined, worktrees: WorktreeMetadata[]): WorktreeMetadata[] => {
  if (!orderedPaths || orderedPaths.length === 0) return worktrees;
  const rank = new Map(orderedPaths.map((path, index) => [normalizeWorktreePath(path), index] as const));
  return worktrees.map((worktree, index) => ({ worktree, index })).sort((left, right) => {
    const byRank = (rank.get(normalizeWorktreePath(left.worktree.path)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(normalizeWorktreePath(right.worktree.path)) ?? Number.MAX_SAFE_INTEGER);
    return byRank || left.index - right.index;
  }).map((entry) => entry.worktree);
};
