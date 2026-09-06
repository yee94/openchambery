/**
 * Cap OpenChamberComposer action chrome layout for Lynx GlassChrome contentView.
 *
 * Cap expanded footer (arranged): + · spacer · Agent · model  (+ Send/Stop pinned trailing).
 * Cap collapsed pill: + · placeholder/input · Send/Stop.
 * Queue-send sits above Stop only while expanded + aborting (Cap); Lynx exposes Queue in-glass.
 *
 * Autocomplete stays a **sibling ABOVE** glass — never in this contentView tree
 * (`composerAutocompleteLayout.forbidInsideGlassContentView`).
 *
 * Source: packages/mobile/README.md § Native iOS Composer,
 * OpenChamberComposerView.swift footer.addArrangedSubview order,
 * docs/lynx-ia-ui.md Composer and IME.
 */

export type LynxComposerActionsChromeVariant = 'pill' | 'card';

/** Tokens that live inside glass contentView (not autocomplete). */
export type LynxComposerInGlassActionToken =
  | 'attach'
  | 'spacer'
  | 'agent'
  | 'model'
  | 'sendOrStop'
  | 'queue'
  | 'input';

/**
 * Cap-matched order for controls that may appear inside LynxComposerGlassCard.
 * Autocomplete is intentionally absent.
 */
export function resolveLynxComposerInGlassActionOrder(
  variant: LynxComposerActionsChromeVariant,
  options?: {
    /** Cap: queue-send only while expanded + session working. */
    showQueue?: boolean;
    /** Collapsed pill includes the text field between + and Send. */
    includeInputInPillRow?: boolean;
  },
): readonly LynxComposerInGlassActionToken[] {
  const showQueue = options?.showQueue === true;
  const includeInput = options?.includeInputInPillRow !== false;

  if (variant === 'pill') {
    const row: LynxComposerInGlassActionToken[] = ['attach'];
    if (includeInput) row.push('input');
    row.push('sendOrStop');
    // Cap collapsed abort shows Stop alone — no queue on pill.
    return row;
  }

  // Expanded card footer (Cap arranged subviews + trailing send).
  const footer: LynxComposerInGlassActionToken[] = [
    'attach',
    'spacer',
    'agent',
    'model',
    'sendOrStop',
  ];
  if (showQueue) footer.push('queue');
  return footer;
}

export const LYNX_COMPOSER_ACTIONS_IN_GLASS = {
  /** Actions + input may nest under GlassChrome; autocomplete must not. */
  actionsInsideGlassContentView: true as const,
  autocompleteInsideGlassContentView: false as const,
  collapsedOrder: resolveLynxComposerInGlassActionOrder('pill'),
  expandedFooterOrder: resolveLynxComposerInGlassActionOrder('card', { showQueue: true }),
  /** Occupancy stays collapsed pill height even when card is expanded. */
  expandedCountsAsOccupancy: false as const,
} as const;

export const LYNX_COMPOSER_ACTIONS_IN_GLASS_WIRING_NOTES = [
  'Move Attach / Send / Stop / Queue inside LynxComposerGlassCard (Cap contentView chrome).',
  'Expanded footer order: + · spacer · Agent · model · Send/Stop (± Queue while working).',
  'Collapsed pill: + · input · Send/Stop — no Agent/model/queue on the pill row.',
  'Autocomplete remains sibling ABOVE glass — never GlassChrome contentView child.',
  'Linux JS wiring only — host Mode B overlay / live UIGlassEffect still 真机 residual.',
] as const;
