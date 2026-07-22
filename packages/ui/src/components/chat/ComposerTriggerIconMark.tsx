import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
    COMPOSER_TRIGGER_ICON_END_INSET,
    COMPOSER_TRIGGER_ICON_SIZE_CLASS,
    type ComposerTriggerIconVisual,
} from '@/composer/inline-visual';

/**
 * Shared textarea-overlay chip renderer.
 * Keeps trigger/suffix glyphs for metrics, paints the icon into the trigger slot,
 * and shows the label after a placement-owned gap.
 */
export function ComposerTriggerIconMark({
    visual,
    text,
}: {
    visual: ComposerTriggerIconVisual;
    text: string;
}) {
    const consumed = visual.trigger.length + visual.label.length + (visual.suffix?.length ?? 0);
    const remainder = text.slice(consumed);
    const iconClassName = visual.align === 'center'
        ? `pointer-events-none absolute left-1/2 top-1/2 ${COMPOSER_TRIGGER_ICON_SIZE_CLASS} -translate-x-1/2 -translate-y-1/2 text-[var(--primary)]`
        : `pointer-events-none absolute top-1/2 ${COMPOSER_TRIGGER_ICON_SIZE_CLASS} -translate-y-1/2 text-[var(--primary)]`;

    return (
        <>
            <span className="relative inline-block align-baseline text-transparent">
                {visual.trigger}
                <Icon
                    name={visual.icon as IconName}
                    className={iconClassName}
                    style={visual.align === 'end'
                        ? { right: visual.slot === 'reserved' ? COMPOSER_TRIGGER_ICON_END_INSET : 0 }
                        : undefined}
                    aria-hidden="true"
                />
            </span>
            <span>{visual.label}</span>
            {visual.suffix ? <span className="text-transparent">{visual.suffix}</span> : null}
            {remainder ? <span className="text-transparent">{remainder}</span> : null}
        </>
    );
}
