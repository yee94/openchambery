import { DRAFT_COMPOSER_TRIGGER_ICON_SLOT } from '@/sync/input-draft-types';

/**
 * Metric-safe Composer chip visuals for the textarea highlight overlay.
 *
 * A controlled reference stores an em-space after its trigger. That source
 * glyph reserves a fixed 1em×1em icon well and label gap without changing
 * textarea metrics. Legacy compact source text still paints the same well
 * end-anchored to a narrow trigger (may overflow left).
 */
export type ComposerTriggerIconAlign = 'center' | 'end';
export type ComposerTriggerIconSlot = 'reserved' | 'compact';

export interface ComposerTriggerIconSpec {
    trigger: string;
    icon: string;
    label: string;
    suffix?: string;
    align?: ComposerTriggerIconAlign;
}

export interface ComposerTriggerIconVisual {
    /** Exact transparent source glyphs reserving the icon's position. */
    trigger: string;
    icon: string;
    align: ComposerTriggerIconAlign;
    label: string;
    suffix?: string;
    /** A reserved slot owns the label gap; compact anchors the icon to the trigger. */
    slot: ComposerTriggerIconSlot;
}

export const COMPOSER_TRIGGER_ICON_SLOT = DRAFT_COMPOSER_TRIGGER_ICON_SLOT;
/**
 * Shared optical gap around the painted trigger icon.
 * Composer overlays use this as equal left/right inset inside the trigger run
 * so the fixed 1em well stays centered with the same air on both sides.
 * Sent-message chips use the same value as flex `gap` after the well.
 */
export const COMPOSER_TRIGGER_ICON_LABEL_GAP = '0.2em';
/** @deprecated Use COMPOSER_TRIGGER_ICON_LABEL_GAP — reserved-slot inset is the shared gap. */
export const COMPOSER_TRIGGER_ICON_END_INSET = COMPOSER_TRIGGER_ICON_LABEL_GAP;
/**
 * Fixed icon well size shared by Composer overlay and sent-message chips.
 * Always 1em×1em so every reference kind paints the same box, independent of
 * trigger glyph width (`[`, `@`, `/`).
 */
export const COMPOSER_TRIGGER_ICON_SIZE_CLASS = 'size-[1em]';
/** @deprecated Icon well is fixed and inset-centered; optical Y nudge is no longer applied. */
export const COMPOSER_TRIGGER_ICON_OPTICAL_NUDGE_Y = '0';

/** Strip a leading reserved icon slot from bracket/slash bodies when matching labels. */
export const stripComposerTriggerIconSlot = (value: string): string => (
    value.startsWith(COMPOSER_TRIGGER_ICON_SLOT) ? value.slice(COMPOSER_TRIGGER_ICON_SLOT.length) : value
);

/** Bracket citation display with a reserved em-space icon well: `[␠filename]`. */
export const attachmentCitationDisplay = (filename: string): string => (
    composerTriggerIconDisplay({
        trigger: '[',
        icon: 'file-image',
        label: filename,
        suffix: ']',
    })
);

const sourceText = ({ trigger, label, suffix = '' }: Pick<ComposerTriggerIconSpec, 'trigger' | 'label' | 'suffix'>): string => (
    `${trigger}${label}${suffix}`
);

/** Visible draft text for a controlled trigger-icon chip. */
export const composerTriggerIconDisplay = (spec: ComposerTriggerIconSpec): string => (
    `${spec.trigger}${COMPOSER_TRIGGER_ICON_SLOT}${spec.label}${spec.suffix ?? ''}`
);

/** Semantic text for direct delivery and legacy drafts, with no visual slot. */
export const composerTriggerIconText = (spec: ComposerTriggerIconSpec): string => sourceText(spec);

/** Accepts both persisted legacy text and the current slot-reserved display. */
export const isComposerTriggerIconDisplay = (display: string, spec: ComposerTriggerIconSpec): boolean => (
    display === composerTriggerIconText(spec) || display === composerTriggerIconDisplay(spec)
);

/** Derives a metric-safe visual from its exact source display. */
export const composerTriggerIconVisual = (
    spec: ComposerTriggerIconSpec,
    display: string,
): ComposerTriggerIconVisual => {
    const reserved = display === composerTriggerIconDisplay(spec);
    return {
        trigger: reserved ? `${spec.trigger}${COMPOSER_TRIGGER_ICON_SLOT}` : spec.trigger,
        icon: spec.icon,
        align: spec.align ?? 'end',
        label: spec.label,
        suffix: spec.suffix,
        slot: reserved ? 'reserved' : 'compact',
    };
};

/** Extracts the semantic label from either display generation of a trigger chip. */
export const composerTriggerIconLabel = (
    display: string,
    trigger: string,
    suffix = '',
): string => {
    const withoutTrigger = display.startsWith(trigger) ? display.slice(trigger.length) : display;
    const withoutSlot = withoutTrigger.startsWith(COMPOSER_TRIGGER_ICON_SLOT)
        ? withoutTrigger.slice(COMPOSER_TRIGGER_ICON_SLOT.length)
        : withoutTrigger;
    return suffix && withoutSlot.endsWith(suffix)
        ? withoutSlot.slice(0, -suffix.length)
        : withoutSlot;
};

export const sameComposerTriggerIconVisual = (
    left?: ComposerTriggerIconVisual,
    right?: ComposerTriggerIconVisual,
): boolean => (
    left === right
    || (
        !!left
        && !!right
        && left.trigger === right.trigger
        && left.icon === right.icon
        && left.align === right.align
        && left.label === right.label
        && left.suffix === right.suffix
        && left.slot === right.slot
    )
);
