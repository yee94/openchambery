/**
 * Cap optical: circular liquid-glass / solid arrow.down above Send.
 * Not part of published composer occupancy — must not shove queue/accessories.
 */
import React, { memo } from 'react';
import { StyleSheet } from 'react-native';

import { GlassDisc, GLASS_DISC_SIZE } from '@/components/chrome/GlassDisc';
import { Text, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { t } from '@/lib/i18n';

export type ScrollToBottomDiscProps = {
  visible: boolean;
  onPress: () => void;
};

function ScrollToBottomDiscImpl({ visible, onPress }: ScrollToBottomDiscProps) {
  const scheme = useColorScheme();
  const text = useThemeColor({}, 'text');
  if (!visible) return null;

  return (
    <GlassDisc
      colorScheme={scheme === 'dark' ? 'dark' : 'light'}
      accessibilityLabel={t('mobile.chat.scrollToBottomAria')}
      onPress={onPress}
      style={styles.disc}
    >
      <Text style={[styles.glyph, { color: text }]} accessible={false}>
        ↓
      </Text>
    </GlassDisc>
  );
}

export const ScrollToBottomDisc = memo(ScrollToBottomDiscImpl);

const styles = StyleSheet.create({
  disc: {
    width: GLASS_DISC_SIZE,
    height: GLASS_DISC_SIZE,
  },
  glyph: {
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 22,
    marginTop: -1,
  },
});
