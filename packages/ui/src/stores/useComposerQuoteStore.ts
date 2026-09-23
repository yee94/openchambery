import { create } from 'zustand';
import { appendComposerQuote, EMPTY_COMPOSER_QUOTES } from '@/stores/composerQuotes';

type ComposerQuoteStore = {
  quotesByKey: Record<string, readonly string[]>;
  addQuote: (key: string, text: string) => void;
  removeQuote: (key: string, index: number) => void;
  removeLast: (key: string) => void;
  clear: (key: string) => void;
  restore: (key: string, quotes: readonly string[]) => void;
};

const withoutKey = (quotesByKey: Record<string, readonly string[]>, key: string): Record<string, readonly string[]> => {
  if (!(key in quotesByKey)) return quotesByKey;
  const next = { ...quotesByKey };
  delete next[key];
  return next;
};

export const useComposerQuoteStore = create<ComposerQuoteStore>((set) => ({
  quotesByKey: {},
  addQuote: (key, text) => set((state) => {
    const current = state.quotesByKey[key] ?? EMPTY_COMPOSER_QUOTES;
    const next = appendComposerQuote(current, text);
    if (next === current) return state;
    return { quotesByKey: { ...state.quotesByKey, [key]: next } };
  }),
  removeQuote: (key, index) => set((state) => {
    const current = state.quotesByKey[key];
    if (!current || index < 0 || index >= current.length) return state;
    const next = current.filter((_, position) => position !== index);
    return { quotesByKey: next.length === 0 ? withoutKey(state.quotesByKey, key) : { ...state.quotesByKey, [key]: next } };
  }),
  removeLast: (key) => set((state) => {
    const current = state.quotesByKey[key];
    if (!current || current.length === 0) return state;
    const next = current.slice(0, -1);
    return { quotesByKey: next.length === 0 ? withoutKey(state.quotesByKey, key) : { ...state.quotesByKey, [key]: next } };
  }),
  clear: (key) => set((state) => ({ quotesByKey: withoutKey(state.quotesByKey, key) })),
  restore: (key, quotes) => set((state) => (
    quotes.length === 0
      ? { quotesByKey: withoutKey(state.quotesByKey, key) }
      : { quotesByKey: { ...state.quotesByKey, [key]: quotes } }
  )),
}));

export const selectComposerQuotes = (key: string | null) => (state: ComposerQuoteStore): readonly string[] => (
  key ? state.quotesByKey[key] ?? EMPTY_COMPOSER_QUOTES : EMPTY_COMPOSER_QUOTES
);
