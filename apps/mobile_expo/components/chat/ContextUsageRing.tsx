import React, { memo } from 'react';
import { StyleSheet, View as RNView } from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import type { MobileContextDisplay } from '@/lib/contextUsage';
import { t } from '@/lib/i18n';

export type ContextUsageRingProps = {
  display: MobileContextDisplay | null;
  /** Inline header slot (no absolute float, no tokens caption). */
  compact?: boolean;
};

const toneColor = (tone: MobileContextDisplay['tone']): string => {
  if (tone === 'critical') return '#F97066';
  if (tone === 'warn') return '#FDB022';
  return '#32D583';
};

function ContextUsageRingImpl({ display, compact }: ContextUsageRingProps) {
  const muted = useThemeColor({}, 'muted');
  if (!display) return null;

  const pct = Math.max(0, Math.min(100, display.percentage));
  const color = toneColor(display.tone);

  return (
    <RNView
      style={[styles.wrap, compact ? styles.wrapCompact : styles.wrapFloat]}
      accessibilityRole="progressbar"
      accessibilityLabel={t('mobile.chat.context.aria', {
        percent: Math.round(pct),
        tokens: display.tokensLabel,
      })}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
    >
      <RNView style={[styles.ring, compact && styles.ringCompact, { borderColor: 'rgba(127,127,127,0.35)' }]}>
        <RNView
          style={[
            styles.progress,
            compact && styles.progressCompact,
            {
              borderColor: color,
              // Approximate ring fill via border opacity + label (no SVG dependency).
              opacity: 0.35 + (pct / 100) * 0.65,
            },
          ]}
        />
        <Text style={[styles.percent, { color }]}>{Math.round(pct)}%</Text>
      </RNView>
      {compact ? null : (
        <Text style={[styles.tokens, { color: muted }]} numberOfLines={1}>
          {display.tokensLabel}
        </Text>
      )}
    </RNView>
  );
}

export const ContextUsageRing = memo(ContextUsageRingImpl);

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: 2,
  },
  wrapFloat: {
    position: 'absolute',
    top: 10,
    right: 12,
    zIndex: 4,
  },
  wrapCompact: {
    position: 'relative',
    top: 0,
    right: 0,
    zIndex: 0,
  },
  ring: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,20,20,0.55)',
  },
  ringCompact: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2.5,
    backgroundColor: 'rgba(127,127,127,0.12)',
  },
  progress: {
    ...StyleSheet.absoluteFill,
    borderRadius: 20,
    borderWidth: 3,
  },
  progressCompact: {
    borderRadius: 18,
    borderWidth: 2.5,
  },
  percent: {
    fontSize: 10,
    fontWeight: '700',
  },
  tokens: {
    fontSize: 10,
    maxWidth: 88,
  },
});
