import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createRuntimeScopedJSONStorage } from '@/lib/runtimeScopedStorage';
import { isRuntimeEndpointIdentityChange, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

// Default wordmark is uppercase so it reads as a mark, not body UI text.
export const DEFAULT_SIDEBAR_BRAND_NAME = 'OPEN CHAMBER';

interface SidebarBrandStore {
  sidebarBrandName: string;
  setSidebarBrandName: (name: string) => void;
}

export const useSidebarBrandStore = create<SidebarBrandStore>()(
  persist(
    (set) => ({
      sidebarBrandName: DEFAULT_SIDEBAR_BRAND_NAME,
      setSidebarBrandName: (name) => {
        const nextName = name.slice(0, 64);
        set((state) => state.sidebarBrandName === nextName ? state : { sidebarBrandName: nextName });
      },
    }),
    {
      // Transport-scoped so packaged multi-window (shared openchamber-ui:// origin)
      // does not leak local brand into a remote-host window (or the reverse).
      name: 'sidebar-brand-store',
      storage: createRuntimeScopedJSONStorage(),
      version: 2,
      migrate: (persistedState, version) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return persistedState;
        }

        const state = persistedState as Partial<SidebarBrandStore>;
        if (version < 1 && state.sidebarBrandName === 'YEE CODE') {
          state.sidebarBrandName = DEFAULT_SIDEBAR_BRAND_NAME;
        }
        // Title-case default → uppercase mark (empty stays empty: hide logo).
        if (version < 2 && state.sidebarBrandName === 'Open Chamber') {
          state.sidebarBrandName = DEFAULT_SIDEBAR_BRAND_NAME;
        }
        return state;
      },
    },
  ),
);

// In-window host switch: rehydrate brand from the new transport's scoped bucket.
if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged((detail) => {
    if (!isRuntimeEndpointIdentityChange(detail)) return;
    void useSidebarBrandStore.persist.rehydrate();
  });
}
