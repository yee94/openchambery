import React, { memo, useMemo } from 'react';
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

/** Segment count for continuous-looking arc without react-native-svg. */
const ARC_SEGMENTS = 40;

type ArcRingProps = {
  size: number;
  stroke: number;
  pct: number;
  color: string;
  trackColor: string;
  children?: React.ReactNode;
};

/**
 * Real progress arc via rotated radial dashes (no SVG/Skia in package.json).
 * Prefer this over opacity-on-full-border approximation.
 */
function ArcRing({ size, stroke, pct, color, trackColor, children }: ArcRingProps) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * ARC_SEGMENTS);
  const radius = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const segLen = (2 * Math.PI * radius) / ARC_SEGMENTS + 1.15;

  const ticks = useMemo(() => {
    return Array.from({ length: ARC_SEGMENTS }, (_, i) => {
      const angle = (i / ARC_SEGMENTS) * Math.PI * 2 - Math.PI / 2;
      const deg = (angle * 180) / Math.PI + 90;
      const active = i < filled;
      return (
        <RNView
          key={i}
          pointerEvents="none"
          style={[
            styles.tick,
            {
              width: stroke,
              height: segLen,
              borderRadius: stroke / 2,
              left: cx - stroke / 2,
              top: cy - segLen / 2,
              backgroundColor: active ? color : trackColor,
              opacity: active ? 1 : 0.55,
              transform: [
                { translateX: Math.cos(angle) * radius },
                { translateY: Math.sin(angle) * radius },
                { rotate: `${deg}deg` },
              ],
            },
          ]}
        />
      );
    });
  }, [color, cx, cy, filled, radius, segLen, stroke, trackColor]);

  return (
    <RNView style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {ticks}
      {children}
    </RNView>
  );
}

function ContextUsageRingImpl({ display, compact }: ContextUsageRingProps) {
  const muted = useThemeColor({}, 'muted');
  if (!display) return null;

  const pct = Math.max(0, Math.min(100, display.percentage));
  const color = toneColor(display.tone);
  const size = compact ? 36 : 40;
  const stroke = compact ? 2.5 : 3;
  const trackColor = 'rgba(127,127,127,0.35)';

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
      <RNView
        style={[
          styles.ringFace,
          compact ? styles.ringFaceCompact : null,
          { width: size, height: size, borderRadius: size / 2 },
        ]}
      >
        <ArcRing size={size} stroke={stroke} pct={pct} color={color} trackColor={trackColor}>
          <Text style={[styles.percent, { color }]}>{Math.round(pct)}%</Text>
        </ArcRing>
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
  ringFace: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,20,20,0.55)',
  },
  ringFaceCompact: {
    backgroundColor: 'rgba(127,127,127,0.12)',
  },
  tick: {
    position: 'absolute',
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
