import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createInstanceScopedJSONStorage } from '@/lib/instanceScopedStorage';
import { isRuntimeInstanceChange, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

type SessionDisplayMode = 'default' | 'minimal';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';

type SessionDisplayStore = {
  displayMode: SessionDisplayMode;
  projectSortOrder: ProjectSortOrder;
  setDisplayMode: (mode: SessionDisplayMode) => void;
  setProjectSortOrder: (order: ProjectSortOrder) => void;
};

export const useSessionDisplayStore = create<SessionDisplayStore>()(
  persist(
    (set) => ({
      displayMode: 'minimal',
      projectSortOrder: 'manual',
      setDisplayMode: (mode) => set({ displayMode: mode }),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
    }),
    {
      name: 'session-display-mode',
      storage: createInstanceScopedJSONStorage(),
      version: 4,
      // v0 shipped 'default' as the only/initial mode, so most existing users
      // have it persisted by accident rather than choice. Nudge everyone onto
      // minimal once so the mode can be evaluated before removing it entirely.
      // v1→v2 adds projectSortOrder defaulting to 'recent'.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<SessionDisplayStore>;
        if (version < 1) {
          return { ...state, displayMode: 'minimal', projectSortOrder: 'manual' };
        }
        if (version < 2) {
          return { ...state, projectSortOrder: 'manual' };
        }
        if (version < 3) {
          return { ...state, projectSortOrder: 'manual' };
        }
        if (version < 4) {
          return {
            displayMode: state.displayMode ?? 'minimal',
            projectSortOrder: state.projectSortOrder ?? 'manual',
          };
        }
        return state;
      },
    },
  ),
);

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged((detail) => {
    if (!isRuntimeInstanceChange(detail)) return;
    void useSessionDisplayStore.persist.rehydrate();
  });
}

export type { ProjectSortOrder };
