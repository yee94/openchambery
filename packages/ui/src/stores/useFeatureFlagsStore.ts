import { create } from 'zustand';

// Timeline engine selection is read from localStorage at boot so a device build
// can be A/B tested without reinstalling: set `oc:legend-timeline` to `0` to
// fall back to the TanStack + auto-follow engine.
const LEGEND_TIMELINE_STORAGE_KEY = 'oc:legend-timeline';

const readLegendTimelineEnabled = (): boolean => {
  try {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem(LEGEND_TIMELINE_STORAGE_KEY) !== '0';
  } catch {
    return true;
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
