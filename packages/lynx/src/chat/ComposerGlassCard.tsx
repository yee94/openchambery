/**
 * Cap-style glass / blur-view composer surface for Lynx Chat + Draft.
 *
 * Replaces elevated solid fill where Cap uses UIGlassEffect / Lynx `<blur-view>`.
 * iOS 26: glass + glass-interactive; older iOS: theme blur; Android: blur-radius only.
 *
 * Cap Attach / Send / Stop / Queue (+ Agent · model on expanded card) live **inside**
 * this card (GlassChrome contentView). Autocomplete must remain a **sibling ABOVE**
 * (never a GlassChrome child). See composerActionsLayout.ts,
 * composerAutocompleteLayout.ts + docs/lynx-ia-ui.md.
 */
import type { ReactNode } from 'react';

import { GlassChrome } from '../glass/GlassChrome';
import type { GlassSurfaceKind } from '../glass/blurView';
import type { LynxHostGlobalProps } from '../host/embedding';
import { LynxView } from '../lynx-elements';

export type LynxComposerGlassVariant = 'pill' | 'card';

export type LynxComposerGlassCardProps = {
  host: LynxHostGlobalProps;
  /** Mode A true; Mode B false (composer glass still resolves — only dock is gated). */
  fullPageAutoGlassSkin: boolean;
  /** Cap collapsed pill vs expanded card. Default card. */
  variant?: LynxComposerGlassVariant;
  children?: ReactNode;
  style?: Record<string, string | number | undefined>;
  accessibilityLabel?: string;
  /**
   * Cap composer-only edge-swipe surface. Host queries
   * `data-session-swipe-surface` on this wrapper (outside blur contentView list).
   */
  sessionSwipeSurface?: boolean;
};

export function composerGlassSurfaceForVariant(
  variant: LynxComposerGlassVariant,
): GlassSurfaceKind {
  return variant === 'pill' ? 'composerPill' : 'composerCard';
}

/**
 * Real GlassChrome / blur-view composer card — no `surface.elevated` solid fill.
 * Call sites must keep autocomplete as a sibling above this component.
 */
export function LynxComposerGlassCard({
  host,
  fullPageAutoGlassSkin,
  variant = 'card',
  children,
  style,
  accessibilityLabel,
  sessionSwipeSurface = false,
}: LynxComposerGlassCardProps) {
  const surface = composerGlassSurfaceForVariant(variant);
  const radius = variant === 'pill' ? '999px' : '12px';

  return (
    <LynxView
      data-lynx-glass-composer="true"
      data-lynx-composer-glass-variant={variant}
      data-session-swipe-surface={sessionSwipeSurface ? 'true' : undefined}
      style={{
        borderRadius: radius,
        overflow: 'hidden',
        ...style,
      }}
    >
      <GlassChrome
        surface={surface}
        host={host}
        fullPageAutoGlassSkin={fullPageAutoGlassSkin}
        accessibilityLabel={accessibilityLabel}
        style={{
          padding: '10px 12px',
          borderRadius: radius,
          // Intentionally no backgroundColor: elevated solid fill — Cap paints glass.
        }}
      >
        {children}
      </GlassChrome>
    </LynxView>
  );
}
