export type {
    MessageReferenceDecoration,
    MessageReferenceDetectContext,
    MessageReferenceIcon,
    MessageReferenceKind,
    MessageReferencePayload,
    MessageReferenceSpan,
    MessageReferenceStrategy,
    MessageTextPart,
} from './types';

export {
    MESSAGE_REFERENCE_CLASS,
    DEFAULT_MESSAGE_REFERENCE_STRATEGIES,
    citationReferenceStrategy,
    commandReferenceStrategy,
    decorateMessageReference,
    mentionReferenceStrategy,
    sessionReferenceStrategy,
    skillReferenceStrategy,
} from './strategies';

export {
    buildMessageReferenceParts,
    detectMessageReferences,
    hasMessageReferenceHint,
    tokenizeMessageReferences,
} from './detect';

export { buildCitationIconsFromParts } from './citations';

export {
    toComposerHighlightRanges,
    type ComposerCompatibleHighlightRange,
} from './composerAdapter';

