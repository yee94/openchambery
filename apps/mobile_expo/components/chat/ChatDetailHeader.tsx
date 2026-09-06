/**
 * Pushed Chat detail nav — Cap optical: 56px band, 40px GlassDisc back/overflow,
 * centered title, context ring inline. Transparent fade (not a frost banner).
 */
import React from 'react';
import { StyleSheet, View as RNView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ContextUsageRing } from '@/components/chat/ContextUsageRing';
import { GlassDisc, GLASS_DISC_SIZE } from '@/components/chrome/GlassDisc';
import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import type { MobileContextDisplay } from '@/lib/contextUsage';
import { t } from '@/lib/i18n';

export type ChatDetailHeaderProps = {
  title: string;
  subtitle?: string | null;
  contextDisplay: MobileContextDisplay | null;
  onBack: () => void;
  onOverflow: () => void;
};

/** Layout height of the sticky band below the status bar inset. */
export const CHAT_DETAIL_NAV_BAND = 56;

export function ChatDetailHeader({
  title,
  subtitle,
  contextDisplay,
  onBack,
  onOverflow,
}: ChatDetailHeaderProps) {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  const text = useThemeColor({}, 'text');
  const muted = useThemeColor({}, 'muted');
  const fadeColor = dark ? 'rgba(10,10,10,0.92)' : 'rgba(250,250,250,0.92)';
  const topInset = Math.max(insets.top, 16);
  const chromeHeight = topInset + CHAT_DETAIL_NAV_BAND;

  return (
    <RNView
      pointerEvents="box-none"
      style={[styles.sticky, { height: chromeHeight, paddingTop: topInset }]}
    >
      <RNView
        pointerEvents="none"
        style={[styles.fade, { height: chromeHeight + 24, backgroundColor: fadeColor }]}
      />
      <RNView style={styles.band}>
        <RNView style={styles.leading}>
          <GlassDisc
            colorScheme={dark ? 'dark' : 'light'}
            accessibilityLabel={t('mobile.chat.backAria')}
            onPress={onBack}
          >
            <Text style={[styles.discGlyph, { color: text }]}>‹</Text>
          </GlassDisc>
        </RNView>

        <RNView style={styles.titleBlock} pointerEvents="none">
          <Text style={[styles.title, { color: text }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: muted }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </RNView>

        <RNView style={styles.trailing}>
          <ContextUsageRing display={contextDisplay} compact />
          <GlassDisc
            colorScheme={dark ? 'dark' : 'light'}
            accessibilityLabel={t('mobile.chat.overflowAria')}
            onPress={onOverflow}
          >
            <Text style={[styles.overflowGlyph, { color: text }]}>···</Text>
          </GlassDisc>
        </RNView>
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  sticky: {
    zIndex: 6,
    backgroundColor: 'transparent',
  },
  fade: {
    ...StyleSheet.absoluteFill,
  },
  band: {
    height: CHAT_DETAIL_NAV_BAND,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  title: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 1,
    fontSize: 11,
    lineHeight: 14,
    textAlign: 'center',
  },
  leading: {
    minWidth: GLASS_DISC_SIZE * 2 + 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: GLASS_DISC_SIZE * 2 + 6,
    justifyContent: 'flex-end',
  },
  discGlyph: {
    fontSize: 28,
    fontWeight: '300',
    marginTop: -2,
    lineHeight: 32,
  },
  overflowGlyph: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
