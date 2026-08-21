import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createInstanceScopedJSONStorage } from '@/lib/instanceScopedStorage';
import { isRuntimeInstanceChange, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

/**
 * Expand/collapse overrides for MobileSessionStatusBar worktree groups.
 *
 * Missing key means collapsed (root groups stay always expanded in the UI).
 * Presence of `true` means the user expanded that worktree group.
 */
type SessionStatusBarCollapseStore = {
  expandedWorktreeGroups: Record<string, boolean>;
  setWorktreeGroupExpanded: (key: string, expanded: boolean) => void;
};

export const useSessionStatusBarCollapseStore = create<SessionStatusBarCollapseStore>()(
  persist(
    (set) => ({
      expandedWorktreeGroups: {},
      setWorktreeGroupExpanded: (key, expanded) =>
        set((state) => ({
          expandedWorktreeGroups: {
            ...state.expandedWorktreeGroups,
            [key]: expanded,
          },
        })),
    }),
    {
      name: 'mobile-session-statusbar-collapse',
      storage: createInstanceScopedJSONStorage(),
    },
  ),
);

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged((detail) => {
    if (!isRuntimeInstanceChange(detail)) return;
    void useSessionStatusBarCollapseStore.persist.rehydrate();
  });
}
