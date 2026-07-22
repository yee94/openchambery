import { decorateMessageReference } from './strategies';
import type { MessageReferenceDecoration, MessageReferenceSpan } from './types';
import {
    composerTriggerIconVisual,
    type ComposerTriggerIconSpec,
    type ComposerTriggerIconVisual,
} from '@/composer/inline-visual';

export const messageReferenceTriggerIconSpec = (
    decoration: MessageReferenceDecoration,
): ComposerTriggerIconSpec | undefined => {
    switch (decoration.kind) {
        case 'session':
            return { trigger: '@', icon: 'chat-thread', label: decoration.label };
        case 'skill':
            return { trigger: '/', icon: 'book-open', label: decoration.label.replace(/^\//, '') };
        case 'command':
            return { trigger: '/', icon: 'command', label: decoration.label.replace(/^\//, '') };
        case 'image':
            return { trigger: '[', icon: 'file-image', label: decoration.label, suffix: ']' };
        case 'attachment':
            return { trigger: '[', icon: 'attachment-2', label: decoration.label, suffix: ']' };
        case 'file':
        case 'agent':
            return undefined;
    }
};

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
