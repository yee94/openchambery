/**
 * Cap `/` `@` autocomplete list — renders ABOVE glass composer.
 *
 * Never nest this inside GlassChrome / UIGlassEffect contentView
 * (Cap: UILabel vibrancy + tap eat). Sibling overlay only.
 *
 * Optional row chips use their own GlassChrome (`searchChip`) **in this
 * sibling tree** — still not inside the composer glass contentView.
 *
 * See composerAutocompleteLayout.ts + docs/lynx-ia-ui.md Autocomplete row.
 */
import { GlassChrome } from '../glass/GlassChrome';
import type { LynxHostGlobalProps } from '../host/embedding';
import { lynxT } from '../i18n/catalog';
import { LynxText, LynxView } from '../lynx-elements';
import { cssVar } from '../theme/tokens';
import {
  computeLynxAutocompleteMaxHeight,
  LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT,
} from './composerAutocompleteLayout';
import type { LynxComposerSuggestion } from './composerCatalog';

export type LynxComposerAutocompleteListProps = {
  locale: string;
  hint: string | null;
  suggestions: LynxComposerSuggestion[];
  onSelect: (suggestion: LynxComposerSuggestion) => void;
  /** Optional Cap-style clamp inputs for maxHeight. */
  spaceBelowHeader?: number;
  visibleColumnHeight?: number;
  maxVisible?: number;
  /**
   * When set with glassRowChips, each row is a searchChip GlassChrome sibling
   * above the composer — never nested under LynxComposerGlassCard.
   */
  host?: LynxHostGlobalProps | null;
  fullPageAutoGlassSkin?: boolean;
  /** Default true when host is provided. */
  glassRowChips?: boolean;
};

/**
 * Sibling overlay ABOVE the glass composer card — not a glass contentView child.
 * data-lynx-autocomplete-placement documents the Cap layout contract for host.
 */
export function LynxComposerAutocompleteList({
  locale,
  hint,
  suggestions,
  onSelect,
  spaceBelowHeader = 400,
  visibleColumnHeight = 500,
  maxVisible = 6,
  host = null,
  fullPageAutoGlassSkin = true,
  glassRowChips,
}: LynxComposerAutocompleteListProps) {
  if (!hint && suggestions.length === 0) return null;

  const maxHeight = computeLynxAutocompleteMaxHeight({
    spaceBelowHeader,
    visibleColumnHeight,
  });
  const useGlassChips = (glassRowChips ?? Boolean(host)) && host != null;

  return (
    <LynxView
      data-lynx-autocomplete-placement={LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.placement}
      data-lynx-autocomplete-forbid-glass-content={
        LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.forbidInsideGlassContentView ? 'true' : 'false'
      }
      data-lynx-autocomplete-glass-row-chips={useGlassChips ? 'true' : 'false'}
      accessibility-label={lynxT(locale, 'lynx.chat.composer.autocompleteAria')}
      style={{
        marginBottom: `${LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.gapAboveCardPt}px`,
        maxHeight: `${maxHeight}px`,
        overflow: 'hidden',
      }}
    >
      {hint ? (
        <LynxText style={{ color: cssVar('surface.mutedForeground'), fontSize: '12px', marginBottom: '4px' }}>
          {hint}
        </LynxText>
      ) : null}
      {suggestions.slice(0, maxVisible).map((suggestion) => {
        const label = (
          <LynxText style={{ color: cssVar('primary.base'), fontSize: '13px' }}>
            {suggestion.insertText}
            {suggestion.subtitle ? ` · ${suggestion.subtitle}` : ''}
          </LynxText>
        );

        if (useGlassChips && host) {
          return (
            <GlassChrome
              key={suggestion.id}
              surface="searchChip"
              host={host}
              fullPageAutoGlassSkin={fullPageAutoGlassSkin}
              style={{
                marginBottom: '4px',
                padding: '6px 10px',
                borderRadius: '10px',
              }}
            >
              <LynxView
                bindtap={() => onSelect(suggestion)}
                accessibility-role="button"
                style={{ padding: '0' }}
              >
                {label}
              </LynxView>
            </GlassChrome>
          );
        }

        return (
          <LynxView
            key={suggestion.id}
            bindtap={() => onSelect(suggestion)}
            style={{ padding: '6px 0' }}
            accessibility-role="button"
          >
            {label}
          </LynxView>
        );
      })}
    </LynxView>
  );
}
