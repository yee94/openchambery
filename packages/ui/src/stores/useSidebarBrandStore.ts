import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createRuntimeScopedJSONStorage } from '@/lib/runtimeScopedStorage';
import { isRuntimeEndpointIdentityChange, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

// The default name selects the approved SVG wordmark in the sidebar.
export const DEFAULT_SIDEBAR_BRAND_NAME = 'Yuri';

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
      // Transport-scoped so packaged multi-window (shared yuri-ui:// origin)
      // does not leak local brand into a remote-host window (or the reverse).
      name: 'sidebar-brand-store',
      storage: createRuntimeScopedJSONStorage(),
      version: 3,
      migrate: (persistedState, version) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return persistedState;
        }

        const state = { ...persistedState } as Partial<SidebarBrandStore>;
        if (version < 1 && state.sidebarBrandName === 'YEE CODE') {
          state.sidebarBrandName = DEFAULT_SIDEBAR_BRAND_NAME;
        }
        // Title-case default → uppercase mark (empty stays empty: hide logo).
        if (version < 2 && state.sidebarBrandName === 'Open Chamber') {
          state.sidebarBrandName = DEFAULT_SIDEBAR_BRAND_NAME;
        }
        // Migrate only historical defaults; custom names and hidden slots survive.
        if (version < 3 && (state.sidebarBrandName === 'OPEN CHAMBER' || state.sidebarBrandName === 'Open Chamber')) {
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
