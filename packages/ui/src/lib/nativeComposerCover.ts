import { nativeIosComposerSession } from './native-ios-composer-session';

type NativeComposerCoverSession = {
  conceal: () => void;
  reveal: () => void;
};

/**
 * Hides the iOS native composer while a web surface must own that slot
 * (selection foot, Side Chat). Nested holders do not reveal early.
 */
export const createNativeComposerCover = (session: NativeComposerCoverSession) => {
  const counts = new Map<string, number>();

  const total = (): number => {
    let sum = 0;
    for (const count of counts.values()) sum += count;
    return sum;
  };

  return {
    hold(id: string): () => void {
      const next = (counts.get(id) ?? 0) + 1;
      counts.set(id, next);
      if (total() === 1) session.conceal();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (counts.get(id) ?? 1) - 1;
        if (left <= 0) counts.delete(id);
        else counts.set(id, left);
        if (total() === 0) session.reveal();
      };
    },
  };
};

const cover = createNativeComposerCover(nativeIosComposerSession);
const ensured = new Map<string, () => void>();

export const holdNativeComposerCover = (id: string): (() => void) => cover.hold(id);

/** Idempotent hold for a route that may be armed before its page effect runs. */
export const ensureNativeComposerCover = (id: string): void => {
  if (ensured.has(id)) return;
  ensured.set(id, cover.hold(id));
};

export const releaseNativeComposerCover = (id: string): void => {
  const release = ensured.get(id);
  if (!release) return;
  ensured.delete(id);
  release();
};

export const BTW_PAGE_NATIVE_COMPOSER_COVER = 'btw-page';
export const BTW_SHEET_NATIVE_COMPOSER_COVER = 'btw-sheet';
export const TEXT_SELECTION_NATIVE_COMPOSER_COVER = 'text-selection';
