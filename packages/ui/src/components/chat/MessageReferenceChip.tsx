import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
    COMPOSER_TRIGGER_ICON_LABEL_GAP,
    COMPOSER_TRIGGER_ICON_SLOT,
    COMPOSER_TRIGGER_ICON_SIZE_CLASS,
} from '@/composer/inline-visual';
import { buildAgentMentionUrl } from '@/lib/messages/inlineMessageLinks';
import {
    messageReferenceTriggerIconSpec,
    type MessageReferenceDecoration,
} from '@/lib/messages/references';

export type MessageReferenceChipProps = {
    decoration: MessageReferenceDecoration;
    onOpenSkill?: (skillName: string) => void;
    /** Queue / compact previews skip interactive wrappers. */
    interactive?: boolean;
};

/**
 * Shared Session / Skill / Command / citation chip used by sent messages and
 * queue previews.
 *
 * Keep the label as normal inline text so it shares the alphabetic baseline with
 * neighboring glyphs (`hey`). The icon paints into the same reserved trigger run
 * as `ComposerTriggerIconMark` (trigger + em-space, equal left/right inset) —
 * not a bare 1em well with a full-size icon. A narrow well lets the command ⌘
 * glyph bleed into the first label letter (`loop` → reads as "Hoop").
 * Do not add `overflow-hidden` on the well — it breaks that shared baseline.
 */
export const MessageReferenceChip: React.FC<MessageReferenceChipProps> = ({
    decoration,
    onOpenSkill,
    interactive = true,
}) => {
    const triggerIconSpec = messageReferenceTriggerIconSpec(decoration);
    const iconName = (triggerIconSpec?.icon ?? decoration.icon) as IconName | undefined;
    const label = triggerIconSpec?.label ?? decoration.label;
    // Match composer reserved-slot metrics: transparent trigger + em-space run.
    // Fallback to the slot alone when a decoration only carries an icon name.
    const triggerRun = triggerIconSpec
        ? `${triggerIconSpec.trigger}${COMPOSER_TRIGGER_ICON_SLOT}`
        : COMPOSER_TRIGGER_ICON_SLOT;

    const content = (
        <span
            className={cn('whitespace-nowrap', decoration.className)}
            data-message-reference-kind={decoration.kind}
        >
            {iconName ? (
                <span
                    // No overflow-hidden: it rewrites the inline-block baseline and
                    // lifts the icon above the label (same contract as ComposerTriggerIconMark).
                    className="relative inline-block shrink-0 align-baseline leading-none"
                    aria-hidden="true"
                >
                    <span className="text-transparent">{triggerRun}</span>
                    <span
                        className="pointer-events-none absolute inset-y-0 inline-flex items-center justify-center"
                        style={{ left: COMPOSER_TRIGGER_ICON_LABEL_GAP, right: COMPOSER_TRIGGER_ICON_LABEL_GAP }}
                    >
                        <Icon
                            name={iconName}
                            className={cn(COMPOSER_TRIGGER_ICON_SIZE_CLASS, 'shrink-0')}
                            aria-hidden="true"
                        />
                    </span>
                </span>
            ) : null}
            {label}
        </span>
    );

    if (!interactive) return content;

    if (decoration.kind === 'skill' && decoration.skillName && onOpenSkill) {
        return (
            <button
                type="button"
                className="inline hover:underline"
                data-skill-name={decoration.skillName}
                onClick={(event) => {
                    event.stopPropagation();
                    onOpenSkill(decoration.skillName!);
                }}
            >
                {content}
            </button>
        );
    }

    if (decoration.kind === 'agent' && decoration.href) {
        return (
            <a
                href={buildAgentMentionUrl(decoration.agentName || decoration.label.replace(/^@/, ''))}
                className="inline hover:underline"
                target="_blank"
                rel="noopener noreferrer"
                data-openchamber-agent-mention="true"
                onClick={(event) => event.stopPropagation()}
            >
                {content}
            </a>
        );
    }

    return content;
};

MessageReferenceChip.displayName = 'MessageReferenceChip';