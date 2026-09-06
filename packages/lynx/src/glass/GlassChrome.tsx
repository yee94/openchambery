import type { ReactNode } from 'react';

import {
  resolveBlurViewAttributes,
  type GlassSurfaceKind,
} from './blurView';
import type { LynxHostGlobalProps } from '../host/embedding';
import { LynxBlurView, LynxView } from '../lynx-elements';
import { themeVariantForId } from '../theme/tokens';

export type GlassChromeProps = {
  surface: GlassSurfaceKind;
  host: LynxHostGlobalProps;
  fullPageAutoGlassSkin: boolean;
  style?: Record<string, string | number | undefined>;
  children?: ReactNode;
  accessibilityLabel?: string;
};

export function GlassChrome({
  surface,
  host,
  fullPageAutoGlassSkin,
  style,
  children,
  accessibilityLabel,
}: GlassChromeProps) {
  const attrs = resolveBlurViewAttributes({
    surface,
    platform: host.platform,
    iosMajorVersion: host.iosMajorVersion,
    themeVariant: themeVariantForId(host.themeId),
    fullPageAutoGlassSkin,
  });

  if (!attrs) {
    return (
      <LynxView style={style} accessibility-label={accessibilityLabel}>
        {children}
      </LynxView>
    );
  }

  return (
    <LynxBlurView
      blur-effect={attrs['blur-effect']}
      glass-style={attrs['glass-style']}
      glass-interactive={attrs['glass-interactive']}
      glass-tint-color={attrs['glass-tint-color']}
      spacing={attrs.spacing}
      blur-radius={attrs['blur-radius']}
      blur-sampling={attrs['blur-sampling']}
      enable-auto-blur={attrs['enable-auto-blur']}
      style={style}
      accessibility-label={accessibilityLabel}
    >
      {children}
    </LynxBlurView>
  );
}
