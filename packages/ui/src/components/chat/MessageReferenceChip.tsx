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
 * neighboring glyphs (`hey`). The icon paints into a reserved 1em well — same
 * metric model as `ComposerTriggerIconMark` — instead of wrapping icon+label in
 * `inline-flex` (flex boxes lose the text baseline and drift vertically).
 */
export const MessageReferenceChip: React.FC<MessageReferenceChipProps> = ({
    decoration,
    onOpenSkill,
    interactive = true,
}) => {
    const triggerIconSpec = messageReferenceTriggerIconSpec(decoration);
    const iconName = (triggerIconSpec?.icon ?? decoration.icon) as IconName | undefined;
    const label = triggerIconSpec?.label ?? decoration.label;

    const content = (
        <span
            className={cn('whitespace-nowrap', decoration.className)}
            data-message-reference-kind={decoration.kind}
        >
            {iconName ? (
                <span
                    className="relative inline-block shrink-0 align-baseline leading-none"
                    style={{ marginRight: COMPOSER_TRIGGER_ICON_LABEL_GAP }}
                    aria-hidden="true"
                >
                    {/* Em-space reserves the same 1em×1em well Composer uses. */}
                    <span className="text-transparent">{COMPOSER_TRIGGER_ICON_SLOT}</span>
                    <span className="pointer-events-none absolute inset-0 inline-flex items-center justify-center">
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