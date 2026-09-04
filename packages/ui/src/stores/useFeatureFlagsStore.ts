import { create } from 'zustand';

// Timeline engine selection is read from localStorage at boot so a device build
// can be A/B tested without reinstalling. TanStack is the runtime default.
// Set `oc:legend-timeline` to `1` to opt into LegendList; any other value
// (unset, `0`, empty) stays on TanStack + auto-follow.
export const LEGEND_TIMELINE_STORAGE_KEY = 'oc:legend-timeline';

export const readLegendTimelineEnabled = (
  storage?: Pick<Storage, 'getItem'> | null,
): boolean => {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (!store) return false;
    return store.getItem(LEGEND_TIMELINE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

type FeatureFlagsStore = {
  legendTimelineEnabled: boolean;
  setLegendTimelineEnabled: (enabled: boolean) => void;
};

export const useFeatureFlagsStore = create<FeatureFlagsStore>((set) => ({
  legendTimelineEnabled: readLegendTimelineEnabled(),
  setLegendTimelineEnabled: (enabled) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LEGEND_TIMELINE_STORAGE_KEY, enabled ? '1' : '0');
      }
    } catch {
      // Persisting the choice is best-effort; the in-memory flag still applies.
    }
    set({ legendTimelineEnabled: enabled });
  },
}));
