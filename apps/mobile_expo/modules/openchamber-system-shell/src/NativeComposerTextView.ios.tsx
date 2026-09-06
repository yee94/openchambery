import { requireNativeViewManager } from 'expo-modules-core';
import React from 'react';

import type { NativeComposerTextViewProps } from './NativeComposerTextView.types';

const NativeView = requireNativeViewManager<NativeComposerTextViewProps>(
  'OpenChamberSystemShell',
  'NativeComposerTextView',
);

/**
 * iOS: real UITextView owns IME. Glass chrome stays in RN GlassComposerShell.
 */
export function NativeComposerTextView(props: NativeComposerTextViewProps) {
  return <NativeView {...props} />;
}

export default NativeComposerTextView;
