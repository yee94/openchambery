import { create } from 'zustand';

const readExactOneFlag = (
  key: string,
  storage?: Pick<Storage, 'getItem'> | null,
): boolean => {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (!store) return false;
    return store.getItem(key) === '1';
  } catch {
    return false;
  }
};

const readUnlessZeroFlag = (
  key: string,
  storage?: Pick<Storage, 'getItem'> | null,
): boolean => {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (!store) return true;
    return store.getItem(key) !== '0';
  } catch {
    return true;
  }
};

const persistExactOneFlag = (key: string, enabled: boolean): void => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, enabled ? '1' : '0');
    }
  } catch {
    // Persisting the choice is best-effort; the in-memory flag still applies.
  }
};

// Timeline engine selection is read from localStorage at boot so a device build
// can be A/B tested without reinstalling. TanStack is the runtime default.
// Set `oc:legend-timeline` to `1` to opt into LegendList; any other value
// (unset, `0`, empty) stays on TanStack + auto-follow.
export const LEGEND_TIMELINE_STORAGE_KEY = 'oc:legend-timeline';

export const readLegendTimelineEnabled = (
  storage?: Pick<Storage, 'getItem'> | null,
): boolean => readExactOneFlag(LEGEND_TIMELINE_STORAGE_KEY, storage);

// Assistant Markdown engine on this experiment branch. Markstream React is
// the default for streaming and settled assistant text. Set
// `oc:markstream-react` to `0` to fall back to marked + Shiki + morphdom.
export const MARKSTREAM_REACT_STORAGE_KEY = 'oc:markstream-react';

export const readMarkstreamReactEnabled = (
  storage?: Pick<Storage, 'getItem'> | null,
): boolean => readUnlessZeroFlag(MARKSTREAM_REACT_STORAGE_KEY, storage);

type FeatureFlagsStore = {
  legendTimelineEnabled: boolean;
  setLegendTimelineEnabled: (enabled: boolean) => void;
  markstreamReactEnabled: boolean;
  setMarkstreamReactEnabled: (enabled: boolean) => void;
};

export const useFeatureFlagsStore = create<FeatureFlagsStore>((set) => ({
  legendTimelineEnabled: readLegendTimelineEnabled(),
  setLegendTimelineEnabled: (enabled) => {
    persistExactOneFlag(LEGEND_TIMELINE_STORAGE_KEY, enabled);
    set({ legendTimelineEnabled: enabled });
  },
  markstreamReactEnabled: readMarkstreamReactEnabled(),
  setMarkstreamReactEnabled: (enabled) => {
    persistExactOneFlag(MARKSTREAM_REACT_STORAGE_KEY, enabled);
    set({ markstreamReactEnabled: enabled });
  },
}));
