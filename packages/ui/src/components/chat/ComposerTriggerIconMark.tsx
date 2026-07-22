import type { CSSProperties } from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
    COMPOSER_TRIGGER_ICON_LABEL_GAP,
    COMPOSER_TRIGGER_ICON_OPTICAL_NUDGE_Y,
    COMPOSER_TRIGGER_ICON_SIZE_CLASS,
    type ComposerTriggerIconVisual,
} from '@/composer/inline-visual';

/**
 * Shared textarea-overlay chip renderer.
 * Keeps trigger/suffix glyphs for metrics, paints the icon into the trigger slot,
 * and shows the label after the shared optical gap (reserved) or flush (compact).
 *
 * Avoid overflow clipping on the trigger box — a 1.125em icon needs slight vertical
 * overflow in a ~1em line, and clipping makes it look shifted up. Left spill is
 * prevented by reserved-slot end inset inside the `/`+em-space advance instead.
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

    const iconStyle: CSSProperties = {
        top: '50%',
        transform: visual.align === 'center'
            ? `translate(-50%, calc(-50% + ${COMPOSER_TRIGGER_ICON_OPTICAL_NUDGE_Y}))`
            : `translateY(calc(-50% + ${COMPOSER_TRIGGER_ICON_OPTICAL_NUDGE_Y}))`,
        ...(visual.align === 'end'
            ? { right: visual.slot === 'reserved' ? COMPOSER_TRIGGER_ICON_LABEL_GAP : 0 }
            : { left: '50%' }),
    };

    return (
        <>
            <span className="relative inline-block align-middle text-transparent">
                {visual.trigger}
                <Icon
                    name={visual.icon as IconName}
                    className={`pointer-events-none absolute ${COMPOSER_TRIGGER_ICON_SIZE_CLASS} text-[var(--primary)]`}
                    style={iconStyle}
                    aria-hidden="true"
                />
            </span>
            <span className="align-middle">{labelText}</span>
            {suffixText ? <span className="text-transparent">{suffixText}</span> : null}
            {remainder ? <span className="text-transparent">{remainder}</span> : null}
        </>
    );
}
