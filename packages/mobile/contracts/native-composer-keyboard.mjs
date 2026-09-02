/** Keep in sync with OpenChamberComposerPlugin.applyKeyboard. */

export const NATIVE_COMPOSER_KEYBOARD_GAP = 12;

export const nextNativeComposerKeyboardSession = (sessionOpen, event) => {
  if (event === 'willShow' || event === 'didShow') return true;
  if (event === 'willHide' || event === 'didHide') return false;
  return sessionOpen;
};

export const nativeComposerBottomGap = ({
  sessionOpen,
  event,
  overlap,
  windowSafeBottom,
}) => {
  const open = nextNativeComposerKeyboardSession(sessionOpen, event);
  if (!open) return Math.max(0, windowSafeBottom) + NATIVE_COMPOSER_KEYBOARD_GAP;
  if (overlap > 1) return overlap + NATIVE_COMPOSER_KEYBOARD_GAP;
  return Math.max(0, windowSafeBottom) + NATIVE_COMPOSER_KEYBOARD_GAP;
};
