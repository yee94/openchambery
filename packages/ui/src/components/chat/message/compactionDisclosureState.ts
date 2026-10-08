import { createContext, useContext, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

// Owned by the transcript view, outside virtualized history and live-tail rows.
// Only explicit expanded choices are retained; collapsing removes the entry.
export const createCompactionDisclosureStore = () => createStore<{
    expanded: ReadonlySet<string>;
    toggle: (id: string) => void;
}>((set) => ({
    expanded: new Set(),
    toggle: (id) => set((state) => {
        const expanded = new Set(state.expanded);
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        return { expanded };
    }),
}));

export const CompactionDisclosureContext = createContext<ReturnType<typeof createCompactionDisclosureStore> | null>(null);

export function useCompactionDisclosure(id: string) {
    const sharedStore = useContext(CompactionDisclosureContext);
    const [initialStore] = useState(() => sharedStore ?? createCompactionDisclosureStore());
    const store = sharedStore ?? initialStore;
    const expanded = useStore(store, (state) => state.expanded.has(id));
    const toggle = useStore(store, (state) => state.toggle);
    return { expanded, toggle };
}
