/**
 * Cap `/` `@` autocomplete list — renders ABOVE glass composer.
 *
 * Never nest this inside GlassChrome / UIGlassEffect contentView
 * (Cap: UILabel vibrancy + tap eat). Sibling overlay only.
 *
 * See composerAutocompleteLayout.ts + docs/lynx-ia-ui.md Autocomplete row.
 */
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
}: LynxComposerAutocompleteListProps) {
  if (!hint && suggestions.length === 0) return null;

  const maxHeight = computeLynxAutocompleteMaxHeight({
    spaceBelowHeader,
    visibleColumnHeight,
  });

  return (
    <LynxView
      data-lynx-autocomplete-placement={LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.placement}
      data-lynx-autocomplete-forbid-glass-content={
        LYNX_COMPOSER_AUTOCOMPLETE_LAYOUT.forbidInsideGlassContentView ? 'true' : 'false'
      }
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
      {suggestions.slice(0, maxVisible).map((suggestion) => (
        <LynxView
          key={suggestion.id}
          bindtap={() => onSelect(suggestion)}
          style={{ padding: '6px 0' }}
          accessibility-role="button"
        >
          <LynxText style={{ color: cssVar('primary.base'), fontSize: '13px' }}>
            {suggestion.insertText}
            {suggestion.subtitle ? ` · ${suggestion.subtitle}` : ''}
          </LynxText>
        </LynxView>
      ))}
    </LynxView>
  );
}
