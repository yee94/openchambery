import type { Message, Part } from '@opencode-ai/sdk/v2';

export interface ChatMessageEntry {
    info: Message;
    parts: Part[];
    /**
     * Parts before display-time synthetic filtering.
     * Used to recover decoration context (e.g. session-mention instructions)
     * without rendering hidden sidecar text in the bubble.
     */
    sourceParts?: Part[];
    /** Assistant history source identity for per-message workspace actions. */
    sourceSessionID?: string;
    sourceDirectory?: string | null;
}

type TurnActivityKind = 'tool' | 'reasoning' | 'justification';

export interface TurnMessageRecord {
    messageId: string;
    role: string;
    parentMessageId?: string;
    message: ChatMessageEntry;
    order: number;
}

export interface TurnPartRecord {
    id: string;
    turnId: string;
    messageId: string;
    part: Part;
    partIndex: number;
    endedAt?: number;
}

export interface TurnActivityRecord extends TurnPartRecord {
    kind: TurnActivityKind;
}

export interface TurnDiffStats {
    additions: number;
    deletions: number;
    files: number;
}

export interface TurnChangedFile {
    file: string;
    additions: number;
    deletions: number;
}

export interface TurnActivityGroup {
    id: string;
    anchorMessageId: string;
    afterToolPartId: string | null;
    parts: TurnActivityRecord[];
}

export interface TurnSummaryRecord {
    text?: string;
    sourceMessageId?: string;
    sourcePartId?: string;
}

export interface TurnStreamState {
    isStreaming: boolean;
    isRetrying: boolean;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
}

/**
 * How the turn finished, derived only from the last assistant message with the
 * OpenCode runLoop continuation semantics.
 * - normal: finish === 'stop' with zero continuation tool parts (ordinary tools
 *   in any state — completed included — count; provider-executed tools and
 *   interrupted orphans do not) and no error
 * - abnormal: error, or a non-stop terminal finish (includes user interrupt)
 * - active: finish === 'tool-calls', any continuation tool part, a missing
 *   finish, or no terminal signal at all (time.completed alone never settles)
 */
export type TurnCompletionDisposition = 'active' | 'normal' | 'abnormal';

/**
 * Activity presentation semantics for a turn, derived only from the user message.
 * - default: ordinary user turn
 * - compaction: user message is a /compact (raw compaction part or normalized text)
 */
export type TurnActivityPresentationKind = 'default' | 'compaction';

export interface TurnRecord {
    turnId: string;
    userMessageId: string;
    userMessage: ChatMessageEntry;
    headerMessageId?: string;
    messages: TurnMessageRecord[];
    assistantMessageIds: string[];
    assistantMessages: ChatMessageEntry[];
    activityParts: TurnActivityRecord[];
    activitySegments: TurnActivityGroup[];
    summary: TurnSummaryRecord;
    summaryText?: string;
    hasTools: boolean;
    hasReasoning: boolean;
    diffStats?: TurnDiffStats;
    changedFiles?: TurnChangedFile[];
    stream: TurnStreamState;
    completionDisposition: TurnCompletionDisposition;
    activityPresentationKind: TurnActivityPresentationKind;
    /**
     * Pure derivation from the current last assistant message: `finish === 'stop'`
     * with zero continuation tool parts (see `assistantMessageLifecycle`), no
     * error, and at least one non-empty, model-produced text part. Never
     * latched — a turn that grows a continuation step flips back to `false`.
     * `projectTurnRecords` always fills it; initial turns start `false`.
     */
    hasConfirmedFinalBody: boolean;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
}

interface TurnMessageMeta {
    turnId: string;
    messageId: string;
    userMessageId: string;
    isUserMessage: boolean;
    isAssistantMessage: boolean;
    isFirstAssistantInTurn: boolean;
    isLastAssistantInTurn: boolean;
    headerMessageId?: string;
}

export interface TurnIndexes {
    turnById: Map<string, TurnRecord>;
    messageToTurnId: Map<string, string>;
    messageMetaById: Map<string, TurnMessageMeta>;
}

export interface TurnProjectionResult {
    turns: TurnRecord[];
    indexes: TurnIndexes;
    lastTurnId: string | null;
    lastTurnMessageIds: Set<string>;
    ungroupedMessageIds: Set<string>;
}

export type Turn = Pick<TurnRecord, 'turnId' | 'userMessage' | 'assistantMessages'>;

export interface TurnGroupingContext {
    turnId: string;
    activityOwnerMessageId?: string;
    isFirstAssistantInTurn: boolean;
    isLastAssistantInTurn: boolean;
    isLatestTurn: boolean;
    summaryBody?: string;
    activityParts?: TurnActivityRecord[];
    activityGroupSegments?: TurnActivityGroup[];
    headerMessageId?: string;
    hasTools: boolean;
    hasReasoning: boolean;
    completionDisposition?: TurnCompletionDisposition;
    activityPresentationKind?: TurnActivityPresentationKind;
    diffStats?: TurnDiffStats;
    changedFiles?: TurnChangedFile[];
    userMessageCreatedAt?: number;
    userMessageVariant?: string;
    durationMs?: number;
    isWorking: boolean;
    /**
     * The whole turn is finished, not merely the message rendering this row.
     * Turn-completion chrome (footer, duration, TPS, changed-files preview) must
     * read this instead of the last assistant's own `finish`/`time.completed`:
     * a multi-step agent stamps those when one step ends, while that message is
     * still the turn's last assistant, so message-level completion published a
     * completed-turn footer in the middle of a running loop.
     */
    isTurnSettled: boolean;
    isGroupExpanded?: boolean;
    toggleGroup?: () => void;
}
