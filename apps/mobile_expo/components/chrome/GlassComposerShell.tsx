import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Dark/light from app theme — maps to GlassView colorScheme + solid fill. */
  colorScheme?: 'light' | 'dark' | 'auto';
};

function canUseGlass(): boolean {
  return Platform.OS === 'ios' && (isGlassEffectAPIAvailable() || isLiquidGlassAvailable());
}

function solidFill(scheme: 'light' | 'dark' | 'auto'): string {
  if (scheme === 'light') {
    return Platform.OS === 'android' ? 'rgba(250,250,250,0.98)' : 'rgba(245,245,247,0.94)';
  }
  if (scheme === 'dark') {
    return Platform.OS === 'android' ? 'rgba(32,32,36,0.96)' : 'rgba(28,28,30,0.92)';
  }
  return Platform.OS === 'android' ? 'rgba(32,32,36,0.96)' : 'rgba(28,28,30,0.92)';
}

/**
 * iOS: real UIGlassEffect via expo-glass-effect when API available.
 * Android / older iOS: solid Material/capsule shell — never claimed as UIGlassEffect.
 * Host for NativeComposerTextView (iOS IME) / RN TextInput (Android) — occupancy stays
 * collapsed-pill only; expand / scroll-to-bottom / autocomplete must not raise accessories.
 */
export function GlassComposerShell({ children, style, colorScheme = 'auto' }: Props) {
  if (canUseGlass()) {
    return (
      <GlassView
        style={[styles.glass, style]}
        glassEffectStyle="regular"
        isInteractive
        colorScheme={colorScheme}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View style={[styles.solid, { backgroundColor: solidFill(colorScheme) }, style]}>
      {children}
    </View>
  );
}

export function composerChromeKind(): 'uiGlassEffect' | 'solid' {
  return canUseGlass() ? 'uiGlassEffect' : 'solid';
}

const styles = StyleSheet.create({
  glass: {
    borderRadius: 24,
    overflow: 'hidden',
  },
  solid: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(127,127,127,0.35)',
  },
});
