import React, { useCallback, type ReactNode } from 'react';
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleSheet,
  View as RNView,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';

/** Cap MobileTabPageHeader collapse distance — layout height stays fixed. */
export const TITLE_COLLAPSE_DISTANCE = 48;
/** Expanded title sits slightly below sticky chrome; spacer scrolls away natively. */
export const EXPAND_SHIFT = 10;
/** Compact chrome band height matching Cap 40px action row. */
export const HEADER_ACTION_SIZE = 40;

type HeaderProps = {
  title: string;
  trailing?: ReactNode;
  scrollY: SharedValue<number>;
  style?: StyleProp<ViewStyle>;
};

/**
 * Sticky collapsing title for root tabs (Projects / Assistant / Scheduled).
 * Layout height is constant; scroll only drives compositor transforms.
 */
export function MobileTabPageHeader({ title, trailing, scrollY, style }: HeaderProps) {
  const insets = useSafeAreaInsets();
  const dark = useColorScheme() === 'dark';
  const text = useThemeColor({}, 'text');
  const headerChrome = Math.max(insets.top, 12) + 12 + HEADER_ACTION_SIZE;
  const fadeColor = dark ? 'rgba(10,10,10,0.92)' : 'rgba(250,250,250,0.92)';

  const headerInnerStyle = useAnimatedStyle(() => {
    const collapse = interpolate(
      scrollY.value,
      [0, TITLE_COLLAPSE_DISTANCE],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return {
      transform: [{ translateY: EXPAND_SHIFT * (1 - collapse) }],
    };
  });

  const titleStyle = useAnimatedStyle(() => {
    const collapse = interpolate(
      scrollY.value,
      [0, TITLE_COLLAPSE_DISTANCE],
      [0, 1],
      Extrapolation.CLAMP,
    );
    const scale = 1 - 0.375 * collapse;
    return {
      transform: [{ scale }],
    };
  });

  const fadeStyle = useAnimatedStyle(() => {
    const collapse = interpolate(
      scrollY.value,
      [0, TITLE_COLLAPSE_DISTANCE],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return { opacity: collapse };
  });

  return (
    <RNView
      pointerEvents="box-none"
      style={[
        styles.stickyHeader,
        { height: headerChrome, paddingTop: Math.max(insets.top, 12) },
        style,
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[styles.headerFade, { height: headerChrome + 28, backgroundColor: fadeColor }, fadeStyle]}
      />
      <Animated.View style={[styles.headerInner, headerInnerStyle]}>
        <Animated.View style={[styles.titleBlock, titleStyle]}>
          <Text style={[styles.title, { color: text }]} numberOfLines={1}>
            {title}
          </Text>
        </Animated.View>
        {trailing ? <RNView style={styles.trailing}>{trailing}</RNView> : null}
      </Animated.View>
    </RNView>
  );
}

/** Hook: shared scrollY + onScroll + list top pad for Cap collapse chrome. */
export function useCollapsingTabHeader() {
  const insets = useSafeAreaInsets();
  const scrollY = useSharedValue(0);
  const headerChrome = Math.max(insets.top, 12) + 12 + HEADER_ACTION_SIZE;
  const listTopPad = headerChrome + EXPAND_SHIFT;

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.value = event.nativeEvent.contentOffset.y;
    },
    [scrollY],
  );

  return { scrollY, onScroll, listTopPad, headerChrome };
}

const styles = StyleSheet.create({
  stickyHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 30,
    paddingHorizontal: 16,
    backgroundColor: 'transparent',
    overflow: 'visible',
  },
  headerFade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  headerInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: HEADER_ACTION_SIZE,
    gap: 12,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    transformOrigin: 'left center',
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -0.6,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
});
