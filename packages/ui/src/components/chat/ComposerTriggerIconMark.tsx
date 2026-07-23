import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
    COMPOSER_TRIGGER_ICON_LABEL_GAP,
    COMPOSER_TRIGGER_ICON_SIZE_CLASS,
    type ComposerTriggerIconVisual,
} from '@/composer/inline-visual';

/**
 * Shared textarea-overlay chip renderer.
 * Keeps trigger/suffix glyphs for metrics and paints the icon into a fixed 1em×1em well.
 *
 * The well is centered in the trigger run with equal left/right inset
 * (`COMPOSER_TRIGGER_ICON_LABEL_GAP`). That keeps icon→label air and lead-in air
 * balanced for every reserved chip (`[`/`@`/`/` + em-space), instead of pinning
 * flush to one edge and leaving the opposite side empty or cramped.
 */
export function ComposerTriggerIconMark({
    visual,
    text,
}: {
    visual: ComposerTriggerIconVisual;
    text: string;
}) {
    const labelStart = visual.trigger.length;
    const labelEnd = labelStart + visual.label.length;
    const suffixEnd = labelEnd + (visual.suffix?.length ?? 0);
    // Always take glyphs from the highlight segment so a stale/partial visual
    // cannot paint more characters than the textarea advances.
    const labelText = text.slice(labelStart, Math.min(labelEnd, text.length));
    const suffixText = text.slice(labelEnd, Math.min(suffixEnd, text.length));
    const remainder = text.slice(Math.min(suffixEnd, text.length));

    return (
        <>
            <span className="relative inline-block align-baseline text-transparent leading-none">
                {visual.trigger}
                <span
                    className="pointer-events-none absolute inset-y-0 inline-flex items-center justify-center"
                    style={{ left: COMPOSER_TRIGGER_ICON_LABEL_GAP, right: COMPOSER_TRIGGER_ICON_LABEL_GAP }}
                >
                    <Icon
                        name={visual.icon as IconName}
                        className={`${COMPOSER_TRIGGER_ICON_SIZE_CLASS} shrink-0 text-[var(--primary)]`}
                        aria-hidden="true"
                    />
                </span>
            </span>
            <span>{labelText}</span>
            {suffixText ? <span className="text-transparent">{suffixText}</span> : null}
            {remainder ? <span className="text-transparent">{remainder}</span> : null}
        </>
    );
}
