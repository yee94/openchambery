import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import React from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

/** Cap chat/detail nav glass disc diameter. */
export const GLASS_DISC_SIZE = 40;

type Props = {
  children: React.ReactNode;
  onPress?: PressableProps['onPress'];
  accessibilityLabel?: string;
  accessibilityRole?: PressableProps['accessibilityRole'];
  /** App theme — drives GlassView colorScheme and Android/solid fill. */
  colorScheme?: 'light' | 'dark' | 'auto';
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
};

function canUseGlass(): boolean {
  return Platform.OS === 'ios' && (isGlassEffectAPIAvailable() || isLiquidGlassAvailable());
}

function solidFill(scheme: 'light' | 'dark' | 'auto'): string {
  if (scheme === 'light') return 'rgba(255,255,255,0.82)';
  if (scheme === 'dark') return 'rgba(38,38,44,0.72)';
  // auto: prefer a neutral mid fill; callers usually pass light|dark
  return Platform.OS === 'android' ? 'rgba(38,38,44,0.88)' : 'rgba(38,38,44,0.72)';
}

/**
 * 40px header action disc.
 * iOS: real UIGlassEffect via expo-glass-effect when available.
 * Android / older iOS: solid system-material capsule — never sold as liquid glass.
 */
export function GlassDisc({
  children,
  onPress,
  accessibilityLabel,
  accessibilityRole = 'button',
  colorScheme = 'auto',
  style,
  disabled,
}: Props) {
  const useGlass = canUseGlass();
  const discStyle = [styles.disc, style];

  const body = useGlass ? (
    <GlassView
      style={discStyle}
      glassEffectStyle="regular"
      isInteractive
      colorScheme={colorScheme}
    >
      {children}
    </GlassView>
  ) : (
    <View
      style={[
        discStyle,
        styles.solid,
        { backgroundColor: solidFill(colorScheme) },
      ]}
    >
      {children}
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

export function headerGlassKind(): 'uiGlassEffect' | 'solid' {
  return canUseGlass() ? 'uiGlassEffect' : 'solid';
}

const styles = StyleSheet.create({
  disc: {
    width: GLASS_DISC_SIZE,
    height: GLASS_DISC_SIZE,
    borderRadius: GLASS_DISC_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  solid: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(127,127,127,0.28)',
  },
  pressed: {
    opacity: 0.85,
  },
});
