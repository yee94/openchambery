import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { State } from '@/sync/types';

type RevertedMessageRecord = {
    message: Message & { role: 'user' };
    parts: Part[];
};

export type RevertedMessageDockState = {
    revertMessageID?: string;
    records: RevertedMessageRecord[];
};

/**
 * Input for building the reverted-message dock.
 * Ticket 02: prefer supplying messages/parts from TranscriptRepository so
 * callers do not couple to child-store field paths. `session` still comes
 * from the directory store (revert metadata is outside transcript ownership).
 */
export type RevertedMessageDockInput = {
    session: Pick<State, 'session'>['session'];
    /** Chronological messages (repository messageOrder projection). */
    messages: readonly Message[];
    /** Parts by message id (repository parts map or store.part). */
    partsByMessageID: Readonly<Record<string, readonly Part[] | undefined>>;
};

const EMPTY_PARTS: Part[] = [];
const EMPTY_REVERTED_RECORDS: RevertedMessageRecord[] = [];

export const EMPTY_REVERTED_MESSAGE_DOCK_STATE: RevertedMessageDockState = {
    revertMessageID: undefined,
    records: EMPTY_REVERTED_RECORDS,
};

const isUserMessage = (message: Message): message is Message & { role: 'user' } => {
    return message.role === 'user';
};

const areRecordsEqual = (left: RevertedMessageRecord[], right: RevertedMessageRecord[]): boolean => {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index]?.message !== right[index]?.message || left[index]?.parts !== right[index]?.parts) {
            return false;
        }
    }
    return true;
};

type LegacyRevertedDockState = {
    session: State['session'];
    message: Record<string, Message[]>;
    part: Record<string, Part[]>;
};

/** @deprecated Prefer the messages/parts form; kept for store-shaped callers. */
export const buildRevertedMessageDockState = (
    state: LegacyRevertedDockState | RevertedMessageDockInput,
    sessionId: string | null,
    previous: RevertedMessageDockState = EMPTY_REVERTED_MESSAGE_DOCK_STATE,
): RevertedMessageDockState => {
    if (!sessionId) {
        return EMPTY_REVERTED_MESSAGE_DOCK_STATE;
    }

    const sessionList = 'session' in state ? state.session : [];
    const session = sessionList.find((item) => item.id === sessionId);
    const revertMessageID = (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID;
    if (!revertMessageID) {
        return EMPTY_REVERTED_MESSAGE_DOCK_STATE;
    }

    const messages = 'messages' in state
        ? state.messages
        : ((state as LegacyRevertedDockState).message[sessionId] ?? []);
    const partsByMessageID = 'partsByMessageID' in state
        ? state.partsByMessageID
        : (state as LegacyRevertedDockState).part;

    const records: RevertedMessageRecord[] = [];
    for (const message of messages) {
        if (!isUserMessage(message) || message.id < revertMessageID) {
            continue;
        }
        records.push({
            message,
            parts: (partsByMessageID[message.id] ?? EMPTY_PARTS) as Part[],
        });
    }

    const next = records.length === 0 ? EMPTY_REVERTED_RECORDS : records;
    if (previous.revertMessageID === revertMessageID && areRecordsEqual(previous.records, next)) {
        return previous;
    }

    return {
        revertMessageID,
        records: next,
    };
};
