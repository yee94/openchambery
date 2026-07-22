import { decorateMessageReference, DEFAULT_MESSAGE_REFERENCE_STRATEGIES } from './strategies';
import type {
    MessageReferenceDetectContext,
    MessageReferenceSpan,
    MessageReferenceStrategy,
    MessageTextPart,
} from './types';

const HINT_CHARS = ['/', '[', '@'] as const;

/** Fast reject for text that cannot contain the first-wave reference forms. */
export const hasMessageReferenceHint = (text: string): boolean => {
    if (!text) return false;
    for (const hint of HINT_CHARS) {
        if (text.includes(hint)) return true;
    }
    return false;
};

const resolveOverlaps = (
    spans: MessageReferenceSpan[],
    priorities: ReadonlyMap<MessageReferenceSpan, number>,
): MessageReferenceSpan[] => {
    if (spans.length <= 1) return spans;

    const ranked = [...spans].sort((left, right) => {
        const priorityDelta = (priorities.get(right) ?? 0) - (priorities.get(left) ?? 0);
        if (priorityDelta !== 0) return priorityDelta;
        if (left.start !== right.start) return left.start - right.start;
        return (right.end - right.start) - (left.end - left.start);
    });

    const accepted: MessageReferenceSpan[] = [];
    for (const candidate of ranked) {
        const overlaps = accepted.some((span) => candidate.start < span.end && candidate.end > span.start);
        if (!overlaps) accepted.push(candidate);
    }

    return accepted.sort((left, right) => left.start - right.start || left.end - right.end);
};

/**
 * Detect non-overlapping reference spans using the strategy registry.
 * Strategies are skipped when their hint gate fails, so plain prose stays cheap.
 */
export const detectMessageReferences = (
    text: string,
    context: MessageReferenceDetectContext = {},
    strategies: readonly MessageReferenceStrategy[] = DEFAULT_MESSAGE_REFERENCE_STRATEGIES,
): MessageReferenceSpan[] => {
    if (!hasMessageReferenceHint(text)) return [];

    const collected: MessageReferenceSpan[] = [];
    const priorities = new Map<MessageReferenceSpan, number>();

    for (const strategy of strategies) {
        if (!strategy.shouldScan(text, context)) continue;
        for (const span of strategy.detect(text, context)) {
            collected.push(span);
            priorities.set(span, strategy.priority);
        }
    }

    return resolveOverlaps(collected, priorities);
};

/** Split source text into plain segments and decorated reference parts. */
export const tokenizeMessageReferences = (
    text: string,
    spans: readonly MessageReferenceSpan[],
    strategies: readonly MessageReferenceStrategy[] = DEFAULT_MESSAGE_REFERENCE_STRATEGIES,
): MessageTextPart[] => {
    if (!text) return [];
    if (spans.length === 0) return [{ type: 'text', text }];

    const parts: MessageTextPart[] = [];
    let cursor = 0;
    for (const span of spans) {
        if (span.start < cursor || span.end <= span.start || span.end > text.length) continue;
        if (span.start > cursor) {
            parts.push({ type: 'text', text: text.slice(cursor, span.start) });
        }
        parts.push({
            type: 'reference',
            span,
            decoration: decorateMessageReference(span, strategies),
        });
        cursor = span.end;
    }
    if (cursor < text.length) {
        parts.push({ type: 'text', text: text.slice(cursor) });
    }
    return parts.length > 0 ? parts : [{ type: 'text', text }];
};

/**
 * One-shot helper for memoized consumers: detect + tokenize.
 * Returns null when there is nothing to decorate so callers can keep the fast path.
 */
export const buildMessageReferenceParts = (
    text: string,
    context: MessageReferenceDetectContext = {},
    strategies: readonly MessageReferenceStrategy[] = DEFAULT_MESSAGE_REFERENCE_STRATEGIES,
): MessageTextPart[] | null => {
    if (!hasMessageReferenceHint(text)) return null;
    const spans = detectMessageReferences(text, context, strategies);
    if (spans.length === 0) return null;
    return tokenizeMessageReferences(text, spans, strategies);
};
