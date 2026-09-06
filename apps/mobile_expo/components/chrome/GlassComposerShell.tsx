import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Dark/light from app theme — maps to GlassView colorScheme. */
  colorScheme?: 'light' | 'dark' | 'auto';
};

/**
 * iOS: real UIGlassEffect via expo-glass-effect when API available.
 * Android / older iOS: solid Material/capsule shell — never claimed as UIGlassEffect.
 */
export function GlassComposerShell({ children, style, colorScheme = 'auto' }: Props) {
  const useGlass =
    Platform.OS === 'ios' && (isGlassEffectAPIAvailable() || isLiquidGlassAvailable());

  if (useGlass) {
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

  return <View style={[styles.solid, style]}>{children}</View>;
}

export function composerChromeKind(): 'uiGlassEffect' | 'solid' {
  if (Platform.OS === 'ios' && (isGlassEffectAPIAvailable() || isLiquidGlassAvailable())) {
    return 'uiGlassEffect';
  }
  return 'solid';
}

const styles = StyleSheet.create({
  glass: {
    borderRadius: 24,
    overflow: 'hidden',
  },
  solid: {
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: Platform.OS === 'android' ? 'rgba(32,32,36,0.96)' : 'rgba(28,28,30,0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(127,127,127,0.35)',
  },
});
