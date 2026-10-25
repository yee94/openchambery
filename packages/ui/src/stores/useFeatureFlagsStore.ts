import { create } from 'zustand';

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

// Assistant Markdown engine on this experiment branch. Markstream React is
// the default for streaming and settled assistant text. Set
// `oc:markstream-react` to `0` to fall back to marked + Shiki + morphdom.
export const MARKSTREAM_REACT_STORAGE_KEY = 'oc:markstream-react';

export const readMarkstreamReactEnabled = (
  storage?: Pick<Storage, 'getItem'> | null,
): boolean => readUnlessZeroFlag(MARKSTREAM_REACT_STORAGE_KEY, storage);

type FeatureFlagsStore = {
  markstreamReactEnabled: boolean;
  setMarkstreamReactEnabled: (enabled: boolean) => void;
};

export const useFeatureFlagsStore = create<FeatureFlagsStore>((set) => ({
  markstreamReactEnabled: readMarkstreamReactEnabled(),
  setMarkstreamReactEnabled: (enabled) => {
    persistExactOneFlag(MARKSTREAM_REACT_STORAGE_KEY, enabled);
    set({ markstreamReactEnabled: enabled });
  },
}));
