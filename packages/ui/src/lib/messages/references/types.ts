/**
 * Shared message-reference model for composer overlay and sent-message display.
 *
 * Keep this layer paint/DOM free: consumers decide how to render decorations.
 * Detection is context-gated so plain text stays O(hint) instead of O(strategies).
 */

export type MessageReferenceKind =
    | 'skill'
    | 'command'
    | 'image'
    | 'attachment'
    | 'session'
    | 'file'
    | 'agent';

export type MessageReferenceIcon =
    | 'book-open'
    | 'command'
    | 'file-image'
    | 'attachment-2'
    | 'chat-thread'
    | null;

export type MessageReferencePayload =
    | { kind: 'skill'; skillName: string }
    | { kind: 'command'; commandName: string; reference?: string }
    | { kind: 'image'; filename: string }
    | { kind: 'attachment'; filename: string }
    | { kind: 'session'; sessionId?: string; sessionLabel: string }
    | { kind: 'file'; path: string }
    | { kind: 'agent'; agentName: string };

export interface MessageReferenceSpan {
    start: number;
    end: number;
    kind: MessageReferenceKind;
    /** Exact matched slice from the source text. */
    raw: string;
    /** Stable display label (composer-facing form when possible). */
    label: string;
    payload: MessageReferencePayload;
}

export interface MessageReferenceDecoration {
    kind: MessageReferenceKind;
    label: string;
    icon: MessageReferenceIcon;
    className: string;
    /** Optional interactive target for consumers that render links/buttons. */
    href?: string;
    skillName?: string;
    sessionId?: string;
    agentName?: string;
    filename?: string;
    path?: string;
}

export interface MessageReferenceDetectContext {
    skillNames?: ReadonlySet<string>;
    commandNames?: ReadonlySet<string>;
    /** Lowercased filename -> visual kind for `[filename]` citations. */
    citationIcons?: ReadonlyMap<string, 'image' | 'attachment'>;
    /** sessionId -> title used when materializing `@session:id`. */
    sessionTitles?: ReadonlyMap<string, string>;
    /** Exact visible Session mentions recovered from the message's semantic context. */
    sessionMentions?: readonly { sessionId: string; sessionLabel: string }[];
    /** Lowercased agent names that should highlight as mentions. */
    agentNames?: ReadonlySet<string>;
    /** Confirmed file mention paths (composer confirmation / delivery extraction). */
    filePaths?: ReadonlySet<string>;
    /** When true, path-like `@foo/bar` mentions highlight even without confirmation. */
    allowPathHeuristics?: boolean;
}

export interface MessageReferenceStrategy {
    kind: MessageReferenceKind;
    /** Higher wins when spans overlap. */
    priority: number;
    /** Cheap gate before scanning; keep false for plain text. */
    shouldScan: (text: string, context: MessageReferenceDetectContext) => boolean;
    detect: (text: string, context: MessageReferenceDetectContext) => MessageReferenceSpan[];
    decorate: (span: MessageReferenceSpan) => MessageReferenceDecoration;
}

export type MessageTextPart =
    | { type: 'text'; text: string }
    | { type: 'reference'; span: MessageReferenceSpan; decoration: MessageReferenceDecoration };
