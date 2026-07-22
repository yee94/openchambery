import { decorateMessageReference } from './strategies';
import type { MessageReferenceSpan } from './types';
import {
    composerTriggerIconVisual,
    type ComposerTriggerIconVisual,
} from '@/composer/inline-visual';

/**
 * Structural highlight range shared with the composer overlay.
 * Kept free of React/DOM imports so the pure reference layer stays reusable.
 */
export type ComposerCompatibleHighlightRange = {
    start: number;
    end: number;
    style: 'mentionCommand' | 'mentionFile' | 'mentionSession' | 'mentionAgent';
    priority?: number;
    visual?: ComposerTriggerIconVisual;
    skillName?: string;
};

const PRIORITY_BY_KIND = {
    skill: 102,
    command: 102,
    image: 101,
    attachment: 101,
    session: 100,
    file: 100,
    agent: 100,
} as const;

/**
 * Project detected message spans into composer overlay ranges.
 * ChatInput can merge these with markdown tokenize ranges without re-detecting.
 */
export const toComposerHighlightRanges = (
    spans: readonly MessageReferenceSpan[],
): ComposerCompatibleHighlightRange[] => {
    return spans.map((span) => {
        const decoration = decorateMessageReference(span);
        switch (span.kind) {
            case 'skill':
                return {
                    start: span.start,
                    end: span.end,
                    style: 'mentionCommand' as const,
                    priority: PRIORITY_BY_KIND.skill,
                    skillName: decoration.skillName,
                    visual: composerTriggerIconVisual(
                        { trigger: '/', icon: 'book-open', label: decoration.skillName ?? decoration.label },
                        span.raw,
                    ),
                };
            case 'command':
                return {
                    start: span.start,
                    end: span.end,
                    style: 'mentionCommand' as const,
                    priority: PRIORITY_BY_KIND.command,
                    visual: composerTriggerIconVisual(
                        { trigger: '/', icon: 'command', label: decoration.label },
                        span.raw,
                    ),
                };
            case 'image':
            case 'attachment':
                return {
                    start: span.start,
                    end: span.end,
                    style: 'mentionFile' as const,
                    priority: PRIORITY_BY_KIND[span.kind],
                    visual: composerTriggerIconVisual(
                        {
                            trigger: '[',
                            icon: span.kind === 'image' ? 'file-image' : 'attachment-2',
                            label: decoration.filename ?? decoration.label,
                            suffix: ']',
                        },
                        span.raw,
                    ),
                };
            case 'session':
                return {
                    start: span.start,
                    end: span.end,
                    style: 'mentionSession' as const,
                    priority: PRIORITY_BY_KIND.session,
                    visual: composerTriggerIconVisual(
                        { trigger: '@', icon: 'chat-thread', label: decoration.label },
                        span.raw,
                    ),
                };
            case 'agent':
                return {
                    start: span.start,
                    end: span.end,
                    style: 'mentionAgent' as const,
                    priority: PRIORITY_BY_KIND.agent,
                };
            case 'file':
            default:
                return {
                    start: span.start,
                    end: span.end,
                    style: 'mentionFile' as const,
                    priority: PRIORITY_BY_KIND.file,
                };
        }
    });
};
