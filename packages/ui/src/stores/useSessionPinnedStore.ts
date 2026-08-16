import { create } from 'zustand';
import { createInstanceScopedStorageAdapter } from '@/lib/instanceScopedStorage';
import { isRuntimeInstanceChange, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { getDeferredSafeStorage } from './utils/safeStorage';

const SESSION_PINNED_STORAGE_KEY = 'oc.sessions.pinned';

type PinnedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const readPinned = (storage: PinnedStorage): Set<string> => {
  try {
    const raw = storage.getItem(SESSION_PINNED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string'));
  } catch {
    return new Set();
  }
};

const persistPinned = (storage: PinnedStorage, ids: Set<string>): void => {
  try {
    storage.setItem(SESSION_PINNED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
};

type SessionPinnedStore = {
  ids: Set<string>;
  setIds: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  toggle: (sessionId: string) => void;
};

const safeStorage = createInstanceScopedStorageAdapter(getDeferredSafeStorage());

export const useSessionPinnedStore = create<SessionPinnedStore>((set, get) => ({
  ids: readPinned(safeStorage),
  setIds: (next) => {
    const current = get().ids;
    const resolved = typeof next === 'function' ? next(current) : next;
    if (resolved === current) return;
    set({ ids: resolved });
    persistPinned(safeStorage, resolved);
  },
  toggle: (sessionId) => {
    const current = get().ids;
    const next = new Set(current);
    if (next.has(sessionId)) {
      next.delete(sessionId);
    } else {
      next.add(sessionId);
    }
    set({ ids: next });
    persistPinned(safeStorage, next);
  },
}));

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged((detail) => {
    if (!isRuntimeInstanceChange(detail)) return;
    useSessionPinnedStore.setState({ ids: readPinned(safeStorage) });
  });
}
