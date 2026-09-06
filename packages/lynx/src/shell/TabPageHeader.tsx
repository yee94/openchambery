import type { ReactNode } from 'react';
import { useState } from 'react';

import { GlassChrome } from '../glass/GlassChrome';
import type { LynxHostGlobalProps } from '../host/embedding';
import { LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import {
  LYNX_COLLAPSING_ACTION_SIZE,
  LYNX_COLLAPSING_EXPAND_SHIFT,
  computeLynxTitleCollapseProgress,
  lynxTitleFontSizeForProgress,
  shouldSkipCollapseWrite,
} from './tabPageHeader';

export type LynxTabPageHeaderProps = {
  title: string;
  eyebrow?: string;
  locale: string;
  host: LynxHostGlobalProps;
  /** Mode A / Android Lynx-owned chrome. Mode B still skins search/header buttons. */
  fullPageAutoGlassSkin: boolean;
  collapseProgress?: number;
  searchOpen?: boolean;
  searchQuery?: string;
  onToggleSearch?: () => void;
  onSearchQueryChange?: (value: string) => void;
  onPrimaryAction?: () => void;
  primaryAccessibilityLabel: string;
  searchAccessibilityLabel: string;
  searchClearAccessibilityLabel: string;
  /** Extra trailing nodes after glass search + primary +. */
  trailingExtra?: ReactNode;
  onScrollTopChange?: (scrollTop: number) => void;
};

/**
 * Cap MobileTabPageHeader spirit: sticky translucent collapsing title + trailing
 * glass search chip + primary +. Layout box constant; progress is compositor-only.
 * iOS 26: blur-view glass; Android: blur-radius only (GlassChrome).
 */
export function LynxTabPageHeader({
  title,
  eyebrow,
  host,
  fullPageAutoGlassSkin,
  collapseProgress: collapseProgressProp,
  searchOpen = false,
  searchQuery = '',
  onToggleSearch,
  onSearchQueryChange,
  onPrimaryAction,
  primaryAccessibilityLabel,
  searchAccessibilityLabel,
  searchClearAccessibilityLabel,
  trailingExtra,
}: LynxTabPageHeaderProps) {
  const [internalProgress, setInternalProgress] = useState(0);
  const [lastWritten, setLastWritten] = useState<number | null>(null);
  const progress = collapseProgressProp ?? internalProgress;
  const titleSize = lynxTitleFontSizeForProgress(progress);

  const applyScrollTop = (scrollTop: number) => {
    const next = computeLynxTitleCollapseProgress({ scrollTop });
    if (shouldSkipCollapseWrite(lastWritten, next)) return;
    setLastWritten(next);
    setInternalProgress(next);
  };

  return (
    <LynxView
      id="lynx-tab-page-header"
      style={{
        flexShrink: 0,
        paddingTop: '12px',
        paddingLeft: '16px',
        paddingRight: '16px',
        paddingBottom: '8px',
        backgroundColor: cssVar('surface.background'),
      }}
      // Host scroll-view bindscroll can call this via ref/harness.
      bindtap={() => applyScrollTop(0)}
    >
      <LynxView
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '16px',
        }}
      >
        <LynxView style={{ flexGrow: 1, minWidth: '0px' }}>
          {eyebrow ? (
            <LynxText
              style={{
                color: cssVar('surface.mutedForeground'),
                fontSize: '11px',
                fontWeight: '500',
                opacity: 1 - progress,
                marginBottom: '2px',
              }}
            >
              {eyebrow}
            </LynxText>
          ) : null}
          <LynxText
            style={{
              color: cssVar('surface.foreground'),
              fontSize: `${titleSize}px`,
              fontWeight: '600',
            }}
          >
            {title}
          </LynxText>
        </LynxView>

        <LynxView
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            minHeight: `${LYNX_COLLAPSING_ACTION_SIZE}px`,
            gap: '14px',
            flexShrink: 0,
          }}
        >
          <GlassChrome
            surface="searchChip"
            host={host}
            fullPageAutoGlassSkin={fullPageAutoGlassSkin}
            style={{
              width: `${LYNX_COLLAPSING_ACTION_SIZE}px`,
              height: `${LYNX_COLLAPSING_ACTION_SIZE}px`,
              borderRadius: `${LYNX_COLLAPSING_ACTION_SIZE / 2}px`,
              alignItems: 'center',
              justifyContent: 'center',
            }}
            accessibilityLabel={searchOpen ? searchClearAccessibilityLabel : searchAccessibilityLabel}
          >
            <LynxView
              bindtap={onToggleSearch}
              accessibility-role="button"
              accessibility-label={searchOpen ? searchClearAccessibilityLabel : searchAccessibilityLabel}
              style={{
                width: '100%',
                height: '100%',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <LynxText style={{ color: cssVar('surface.foreground'), fontSize: '16px' }}>
                {searchOpen ? '✕' : '⌕'}
              </LynxText>
            </LynxView>
          </GlassChrome>

          <LynxView
            bindtap={onPrimaryAction}
            accessibility-role="button"
            accessibility-label={primaryAccessibilityLabel}
            style={{
              width: `${LYNX_COLLAPSING_ACTION_SIZE}px`,
              height: `${LYNX_COLLAPSING_ACTION_SIZE}px`,
              borderRadius: `${LYNX_COLLAPSING_ACTION_SIZE / 2}px`,
              backgroundColor: cssVar('primary.base'),
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <LynxText style={{ color: cssVar('primary.foreground'), fontSize: '22px', fontWeight: '600' }}>
              +
            </LynxText>
          </LynxView>

          {trailingExtra}
        </LynxView>
      </LynxView>

      {/* Static in-flow spacer — scrolls away; never rewrite sticky height. */}
      <LynxView
        style={{ height: `${LYNX_COLLAPSING_EXPAND_SHIFT}px` }}
        accessibility-element={false}
      />

      {searchOpen ? (
        <LynxView
          style={{
            marginTop: '4px',
            marginBottom: '8px',
            padding: '10px 14px',
            borderRadius: '999px',
            backgroundColor: cssVar('surface.elevated'),
          }}
        >
          <LynxText
            style={{
              color: searchQuery ? cssVar('surface.foreground') : cssVar('surface.mutedForeground'),
            }}
            bindtap={() => onSearchQueryChange?.(searchQuery)}
          >
            {searchQuery || '…'}
          </LynxText>
        </LynxView>
      ) : null}
    </LynxView>
  );
}

/** Harness: apply scrollTop to a header progress setter. */
export function applyLynxTabHeaderScroll(
  scrollTop: number,
  setProgress: (progress: number) => void,
  previous: number | null,
): number {
  const next = computeLynxTitleCollapseProgress({ scrollTop });
  if (!shouldSkipCollapseWrite(previous, next)) setProgress(next);
  return next;
}
