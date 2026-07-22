import {
    DRAFT_COMPOSER_REFERENCE_LIMITS,
    isValidDraftComposerCommandName,
    isValidDraftComposerCommandReference,
    isValidDraftComposerSkillName,
    isValidDraftComposerSessionID,
    type DraftComposerReference,
} from '@/sync/input-draft-types';
import { countUnicodeCodePoints } from '@/lib/unicodeMetrics';

export type ComposerReference = DraftComposerReference;
export type ComposerReferenceKind = ComposerReference['kind'];
export type SessionComposerReference = Extract<ComposerReference, { kind: 'session' }>;
export type PasteComposerReference = Extract<ComposerReference, { kind: 'paste' }>;
export type SkillComposerReference = Extract<ComposerReference, { kind: 'skill' }>;
export type CommandComposerReference = Extract<ComposerReference, { kind: 'command' }>;
export type NewComposerReference = ComposerReference extends infer Reference
    ? Reference extends ComposerReference ? Omit<Reference, 'start' | 'end'> : never
    : never;

export const COMPOSER_REFERENCE_LIMITS = {
    ...DRAFT_COMPOSER_REFERENCE_LIMITS,
    sessionIdLength: DRAFT_COMPOSER_REFERENCE_LIMITS.sessionIDLength,
    visibleTextLength: 100_000,
    canonicalOutputLength: 200_000,
} as const;

export interface ComposerReferenceMaterializationContext {
    text: string;
    sessionTitles: ReadonlyMap<string, string>;
}

export interface ComposerCanonicalCodec<K extends ComposerReferenceKind = ComposerReferenceKind> {
    matcher: RegExp;
    resolveDisplay: (match: RegExpExecArray, context: ComposerReferenceMaterializationContext) => string | null;
    materialize: (match: RegExpExecArray, display: string, start: number) => Extract<ComposerReference, { kind: K }>;
}

export type ComposerReferenceSemantic =
    | { type: 'session'; sessionId: string }
    | { type: 'skill'; skillName: string }
    | { type: 'attachment'; attachmentRefID: string };
export type ComposerReferenceContribution = { text: string; semantic?: ComposerReferenceSemantic };
export type ComposerReferenceDecoration =
    | { style: 'mentionSession'; sessionLabel: string }
    | { style: 'mentionPaste' }
    | { style: 'mentionCommand'; skillName?: string };
export type ComposerReferenceResourceIdentity = { type: 'attachment'; attachmentRefID: string };
export type ComposerPayloadBudget = { category: 'opaque-text'; length: number };
export interface ComposerResourceDelta {
    previous: ComposerReferenceResourceIdentity[];
    next: ComposerReferenceResourceIdentity[];
    added: ComposerReferenceResourceIdentity[];
    removed: ComposerReferenceResourceIdentity[];
}

export interface ComposerReferenceExtension<K extends ComposerReferenceKind> {
    kind: K;
    validatePayload: (value: Record<string, unknown>) => boolean;
    contributeCanonical: (reference: Extract<ComposerReference, { kind: K }>) => ComposerReferenceContribution;
    contributeDirectSend: (reference: Extract<ComposerReference, { kind: K }>) => ComposerReferenceContribution;
    decorate: (reference: Extract<ComposerReference, { kind: K }>) => ComposerReferenceDecoration;
    payloadBudget: (reference: Extract<ComposerReference, { kind: K }>) => ComposerPayloadBudget | undefined;
    canonical?: ComposerCanonicalCodec<K>;
    describeResourceIdentity?: (reference: Extract<ComposerReference, { kind: K }>) => ComposerReferenceResourceIdentity | undefined;
}

export const isValidComposerSessionId = (value: unknown): value is string => typeof value === 'string' && isValidDraftComposerSessionID(value);

const commandNameFromReference = (reference: string): string => reference.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.md$/, '') ?? '';

const COMPOSER_REFERENCE_EXTENSIONS = {
    session: {
        kind: 'session',
        validatePayload: (value) => isValidComposerSessionId(value.sessionId),
        contributeCanonical: (reference) => ({ text: `@session:${reference.sessionId}`, semantic: { type: 'session', sessionId: reference.sessionId } }),
        contributeDirectSend: (reference) => ({ text: reference.display, semantic: { type: 'session', sessionId: reference.sessionId } }),
        decorate: (reference) => ({ style: 'mentionSession', sessionLabel: reference.display.slice(1) }),
        payloadBudget: () => undefined,
        canonical: {
            matcher: /@session:([A-Za-z0-9_-]+)/g,
            resolveDisplay: (match, context) => {
                const preceding = match.index === 0 ? '' : context.text[match.index - 1];
                const following = context.text[match.index + match[0].length] ?? '';
                return (preceding === '' || /[\s([{]/.test(preceding)) && (following === '' || /[\s)\]},.!?;:]/.test(following))
                    ? `@${context.sessionTitles.get(match[1]) || match[1]}`
                    : null;
            },
            materialize: (match, display, start) => ({ id: `session:${match[1]}:${match.index}`, kind: 'session', sessionId: match[1], display, start, end: start + display.length }),
        },
    },
    paste: {
        kind: 'paste',
        validatePayload: (value) => typeof value.text === 'string'
            && value.text.length <= COMPOSER_REFERENCE_LIMITS.pastePayloadLength
            && typeof value.characterCount === 'number'
            && Number.isSafeInteger(value.characterCount)
            && value.characterCount === countUnicodeCodePoints(value.text)
            && typeof value.index === 'number'
            && Number.isSafeInteger(value.index)
            && value.index >= 1,
        contributeCanonical: (reference) => ({ text: reference.text }),
        contributeDirectSend: (reference) => ({ text: reference.text }),
        decorate: () => ({ style: 'mentionPaste' }),
        payloadBudget: (reference) => ({ category: 'opaque-text', length: reference.text.length }),
    },
    skill: {
        kind: 'skill',
        validatePayload: (value) => isValidDraftComposerSkillName(value.skillName) && value.display === `/${value.skillName}`,
        contributeCanonical: (reference) => ({ text: `[skill:${reference.skillName}]` }),
        contributeDirectSend: (reference) => ({ text: `[skill:${reference.skillName}]` }),
        decorate: (reference) => ({ style: 'mentionCommand', skillName: reference.skillName }),
        payloadBudget: () => undefined,
        canonical: {
            matcher: /\[skill:([A-Za-z0-9][A-Za-z0-9_-]*)\]/g,
            resolveDisplay: (match) => `/${match[1]}`,
            materialize: (match, display, start) => ({ id: `skill:${start}`, kind: 'skill', skillName: match[1], display, start, end: start + display.length }),
        },
    },
    command: {
        kind: 'command',
        validatePayload: (value) => isValidDraftComposerCommandName(value.commandName)
            && isValidDraftComposerCommandReference(value.reference)
            && value.display === `/${value.commandName}`,
        contributeCanonical: (reference) => ({ text: `[command:${reference.reference}]` }),
        contributeDirectSend: (reference) => ({ text: `[command:${reference.reference}]` }),
        decorate: () => ({ style: 'mentionCommand' }),
        payloadBudget: () => undefined,
        canonical: {
            matcher: /\[command:([^\]\r\n]+)\]/g,
            resolveDisplay: (match) => {
                const commandName = commandNameFromReference(match[1]);
                return isValidDraftComposerCommandReference(match[1]) && isValidDraftComposerCommandName(commandName) ? `/${commandName}` : null;
            },
            materialize: (match, display, start) => ({ id: `command:${start}`, kind: 'command', commandName: commandNameFromReference(match[1]), reference: match[1], display, start, end: start + display.length }),
        },
    },
} as const satisfies { [K in ComposerReference['kind']]: ComposerReferenceExtension<K> };

const extensionFor = <K extends ComposerReferenceKind>(kind: K): ComposerReferenceExtension<K> => COMPOSER_REFERENCE_EXTENSIONS[kind] as unknown as ComposerReferenceExtension<K>;

export const validateComposerReferencePayload = (kind: ComposerReferenceKind, value: Record<string, unknown>): boolean => extensionFor(kind).validatePayload(value);
export const contributeComposerReferenceCanonical = (reference: ComposerReference): ComposerReferenceContribution => extensionFor(reference.kind).contributeCanonical(reference);
export const contributeComposerReferenceDirectSend = (reference: ComposerReference): ComposerReferenceContribution => extensionFor(reference.kind).contributeDirectSend(reference);
export const decorateComposerReference = (reference: ComposerReference): ComposerReferenceDecoration => extensionFor(reference.kind).decorate(reference);
export const getComposerReferencePayloadBudget = (reference: ComposerReference): ComposerPayloadBudget | undefined => extensionFor(reference.kind).payloadBudget(reference);
export const describeComposerReferenceResourceIdentity = (reference: ComposerReference): ComposerReferenceResourceIdentity | undefined => extensionFor(reference.kind).describeResourceIdentity?.(reference);
const composerReferenceKinds = Object.keys(COMPOSER_REFERENCE_EXTENSIONS) as ComposerReferenceKind[];

export const isComposerReferenceKind = (value: unknown): value is ComposerReferenceKind => typeof value === 'string' && composerReferenceKinds.includes(value as ComposerReferenceKind);
export const getComposerCanonicalCodecs = (): readonly ComposerCanonicalCodec[] => composerReferenceKinds.flatMap((kind) => {
    const canonical = extensionFor(kind).canonical;
    return canonical ? [canonical] : [];
});

const resourceIdentityKey = (identity: ComposerReferenceResourceIdentity): string => {
    switch (identity.type) {
        case 'attachment': return `attachment:${identity.attachmentRefID}`;
    }
};

/** Aggregates strategy-owned resources so UI callers never infer identity from raw references. */
export const describeComposerDocumentResources = (document: { references: readonly ComposerReference[] }): ComposerReferenceResourceIdentity[] => {
    const identities = new Map<string, ComposerReferenceResourceIdentity>();
    for (const reference of document.references) {
        const identity = describeComposerReferenceResourceIdentity(reference);
        if (identity) identities.set(resourceIdentityKey(identity), identity);
    }
    return [...identities.values()];
};

export const diffComposerResources = (previous: readonly ComposerReferenceResourceIdentity[], next: readonly ComposerReferenceResourceIdentity[]): ComposerResourceDelta => {
    const previousByKey = new Map(previous.map((identity) => [resourceIdentityKey(identity), identity]));
    const nextByKey = new Map(next.map((identity) => [resourceIdentityKey(identity), identity]));
    return {
        previous: [...previousByKey.values()],
        next: [...nextByKey.values()],
        added: [...nextByKey].flatMap(([key, identity]) => previousByKey.has(key) ? [] : [identity]),
        removed: [...previousByKey].flatMap(([key, identity]) => nextByKey.has(key) ? [] : [identity]),
    };
};

export const diffComposerDocumentResources = (previous: { references: readonly ComposerReference[] }, next: { references: readonly ComposerReference[] }): ComposerResourceDelta => {
    return diffComposerResources(describeComposerDocumentResources(previous), describeComposerDocumentResources(next));
};
