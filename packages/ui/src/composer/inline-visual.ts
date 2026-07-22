import { DRAFT_COMPOSER_TRIGGER_ICON_SLOT } from '@/sync/input-draft-types';

/**
 * Metric-safe Composer chip visuals for the textarea highlight overlay.
 *
 * A controlled reference stores an em-space after its trigger. That source
 * glyph reserves the icon and label gap without changing textarea metrics.
 * Legacy or authored raw text renders with a compact icon inside its trigger.
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
    /** A reserved slot supports the full-size icon and owned label gap. */
    slot: ComposerTriggerIconSlot;
}

export const COMPOSER_TRIGGER_ICON_SLOT = DRAFT_COMPOSER_TRIGGER_ICON_SLOT;
export const COMPOSER_TRIGGER_ICON_END_INSET = '0.4em';

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
