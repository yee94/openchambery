/**
 * Host IME inset publisher — Cap native composer keyboard spirit.
 * Host observes keyboard frame / WindowInsetsCompat.ime and publishes
 * `keyboardInset` on the Lynx host bridge. Occupancy stays collapsed-only
 * (`imeOccupancy.ts`); inset growth must not rewrite list occupancy.
 *
 * Autocomplete / command list must sit ABOVE the glass composer card
 * (not inside UIGlassEffect.contentView) — Cap burned on invisible taps/titles.
 */
export type LynxImeInsetSnapshot = {
  /** Keyboard overlap in logical px (0 when closed). */
  keyboardHeight: number;
  /** Safe-area bottom (home indicator). */
  safeAreaBottom: number;
  /** Collapsed composer foot height — occupancy source of truth. */
  collapsedComposerHeight: number;
};

export type LynxImeInsetListener = (snapshot: LynxImeInsetSnapshot) => void;

export type LynxImeInsetBinder = {
  /** Subscribe; returns unsubscribe. Host must call listener on keyboard change. */
  subscribe: (listener: LynxImeInsetListener) => () => void;
  getSnapshot: () => LynxImeInsetSnapshot;
};

export type LynxImeInsetPublisher = {
  inject: (binder: LynxImeInsetBinder | null) => void;
  isAvailable: () => boolean;
  subscribe: (listener: LynxImeInsetListener) => () => void;
  getSnapshot: () => LynxImeInsetSnapshot;
};

export const LYNX_IME_INSET_DEFAULT: LynxImeInsetSnapshot = {
  keyboardHeight: 0,
  safeAreaBottom: 0,
  collapsedComposerHeight: 56,
};

export const LYNX_IME_INSET_WIRING_NOTES = [
  'iOS: observe UIResponder.keyboardWillChangeFrameNotification; convert end frame to host view.',
  'Android: ViewCompat.setOnApplyWindowInsetsListener + WindowInsetsCompat.Type.ime().',
  'Emit LynxHostBridgeEvent keyboardInset { height } for Lynx layout; do not FLIP WebView CSS.',
  'Autocomplete/command list: ABOVE glass composer, sibling of glass card — never contentView child.',
] as const;

export const createLynxImeInsetPublisher = (): LynxImeInsetPublisher => {
  let binder: LynxImeInsetBinder | null = null;
  return {
    inject: (next) => {
      binder = next;
    },
    isAvailable: () => binder !== null,
    subscribe: (listener) => {
      if (!binder) return () => {};
      return binder.subscribe(listener);
    },
    getSnapshot: () => binder?.getSnapshot() ?? { ...LYNX_IME_INSET_DEFAULT },
  };
};
