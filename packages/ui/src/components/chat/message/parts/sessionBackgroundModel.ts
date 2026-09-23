import {
    isBackgroundableToolName,
    isShellToolName,
    isTaskToolName,
    normalizeTaskToolName,
    parseShellNotification,
    parseSubagentNotification,
    readTaskSessionIdFromRecord,
    readTaskStatusFromRecord,
    type ShellNotificationState,
    type SubagentNotificationState,
} from './taskToolModel';

export type BackgroundWorkKind = 'subagent' | 'shell';

export type SessionBlockingWork = {
    type: BackgroundWorkKind;
    partID: string;
    /** Child session id (subagent) or shell id when known. */
    id?: string;
    label?: string;
};

export type SessionBackgroundTask = {
    id: string;
    type: BackgroundWorkKind;
    label: string;
    agent?: string;
};

export type SessionBackgroundProjection = {
    /** Foreground tools currently blocking the parent turn (status=running). */
    blocking: SessionBlockingWork[];
    /** Settled tools still running in the background (tool completed + live authority). */
    backgroundTasks: SessionBackgroundTask[];
};

/** Terminal facts projected from synthetic completion notices / metadata. */
export type BackgroundCompletionState = ShellNotificationState | SubagentNotificationState;

export type BackgroundCompletionIndex = {
    /** shellID / jobID / tag id → terminal state */
    byShellOrJobID: ReadonlyMap<string, BackgroundCompletionState>;
    /** child sessionID → terminal state */
    byChildSessionID: ReadonlyMap<string, BackgroundCompletionState>;
};

export type BackgroundToolActivity =
    | { kind: 'blocking' }
    | { kind: 'background-running' }
    | { kind: 'terminal'; state: BackgroundCompletionState }
    | { kind: 'settled' };

type ToolLikePart = {
    id?: unknown;
    type?: unknown;
    tool?: unknown;
    name?: unknown;
    state?: unknown;
};

type MessageLike = {
    role?: unknown;
    info?: { role?: unknown };
    parts?: unknown;
    content?: unknown;
    metadata?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
};

const readString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const toolNameOf = (part: ToolLikePart): string => {
    return normalizeTaskToolName(part.tool ?? part.name);
};

const toolStateOf = (part: ToolLikePart): Record<string, unknown> | undefined => {
    return asRecord(part.state);
};

const toolMetadataOf = (part: ToolLikePart): Record<string, unknown> | undefined => {
    const state = toolStateOf(part);
    return asRecord(state?.metadata) ?? asRecord((part as { metadata?: unknown }).metadata);
};

const toolInputOf = (part: ToolLikePart): Record<string, unknown> | undefined => {
    const state = toolStateOf(part);
    return asRecord(state?.input) ?? asRecord((part as { input?: unknown }).input);
};

const toolStatusOf = (part: ToolLikePart): string | undefined => {
    const state = toolStateOf(part);
    return readString(state?.status)?.toLowerCase();
};

const partsOfMessage = (message: MessageLike): ToolLikePart[] => {
    const raw = Array.isArray(message.parts)
        ? message.parts
        : Array.isArray(message.content)
            ? message.content
            : [];
    return raw.filter((entry): entry is ToolLikePart => Boolean(entry) && typeof entry === 'object');
};

const messageRoleOf = (message: MessageLike): string | undefined => {
    const role = message.role ?? message.info?.role;
    return typeof role === 'string' ? role : undefined;
};

const extractMessageTexts = (message: MessageLike): string[] => {
    const texts: string[] = [];
    const meta = asRecord(message.metadata);
    const metaText = readString(meta?.text);
    if (metaText) texts.push(metaText);
    for (const part of partsOfMessage(message)) {
        const text = readString((part as { text?: unknown }).text);
        if (text) texts.push(text);
    }
    const topText = readString((message as { text?: unknown }).text);
    if (topText) texts.push(topText);
    return texts;
};

const normalizeTerminalState = (value: unknown): BackgroundCompletionState | undefined => {
    const raw = readString(value)?.toLowerCase();
    if (raw === 'completed' || raw === 'error' || raw === 'cancelled') return raw;
    return undefined;
};

/**
 * Project authoritative background completion facts from parent-session
 * synthetic notices. Official shell background never terminal-patches the tool
 * part — completion arrives as synthetic `<shell …>` / metadata source=shell.
 * Subagent completion arrives as `<subagent …>` / source=subagent.
 */
export const collectBackgroundCompletions = (
    messages: MessageLike[],
): BackgroundCompletionIndex => {
    const byShellOrJobID = new Map<string, BackgroundCompletionState>();
    const byChildSessionID = new Map<string, BackgroundCompletionState>();

    const rememberShell = (id: string | undefined, state: BackgroundCompletionState) => {
        if (!id) return;
        byShellOrJobID.set(id, state);
    };
    const rememberChild = (id: string | undefined, state: BackgroundCompletionState) => {
        if (!id) return;
        byChildSessionID.set(id, state);
    };

    for (const message of messages) {
        const meta = asRecord(message.metadata);
        const source = readString(meta?.source)?.toLowerCase();
        const metaState = normalizeTerminalState(meta?.state);

        if (source === 'shell' && metaState) {
            rememberShell(readString(meta?.shellID), metaState);
            rememberShell(readString(meta?.jobID), metaState);
            rememberShell(readString(meta?.id), metaState);
        }
        if (source === 'subagent' && metaState) {
            rememberChild(
                readString(meta?.childID)
                    ?? readString(meta?.sessionID)
                    ?? readString(meta?.sessionId),
                metaState,
            );
        }

        for (const text of extractMessageTexts(message)) {
            const shellNotice = parseShellNotification(text);
            if (shellNotice) {
                rememberShell(shellNotice.id, shellNotice.state);
                rememberShell(shellNotice.shellID, shellNotice.state);
                rememberShell(shellNotice.jobID, shellNotice.state);
            }
            const subNotice = parseSubagentNotification(text);
            if (subNotice) {
                rememberChild(subNotice.sessionID, subNotice.state);
            }
        }
    }

    return { byShellOrJobID, byChildSessionID };
};

/**
 * Historical settled-tool metadata may still say status=running forever (official
 * shell background never patches the tool part). That is only a *hint* that
 * background work was started — never proof it is still live.
 */
export const hasSettledBackgroundRunningHint = (part: unknown): boolean => {
    if (!part || typeof part !== 'object') return false;
    const toolPart = part as ToolLikePart;
    if (toolPart.type !== undefined && toolPart.type !== 'tool') return false;
    if (!isBackgroundableToolName(toolNameOf(toolPart))) return false;
    const status = toolStatusOf(toolPart);
    if (status !== 'completed') return false;
    const metadata = toolMetadataOf(toolPart);
    return readTaskStatusFromRecord(metadata) === 'running'
        || readTaskStatusFromRecord(toolStateOf(toolPart)) === 'running';
};

/** @deprecated Prefer hasSettledBackgroundRunningHint + resolveBackgroundToolActivity. */
export const isBackgroundRunningToolPart = (part: unknown): boolean => {
    return hasSettledBackgroundRunningHint(part);
};

/**
 * True while a backgroundable tool is still in the foreground tool-call lifecycle
 * (state.status running/pending/started) and therefore eligible for session.background.
 */
export const isBlockingForegroundToolPart = (part: unknown): boolean => {
    if (!part || typeof part !== 'object') return false;
    const toolPart = part as ToolLikePart;
    if (toolPart.type !== undefined && toolPart.type !== 'tool') return false;
    if (!isBackgroundableToolName(toolNameOf(toolPart))) return false;
    const status = toolStatusOf(toolPart);
    return status === 'running' || status === 'pending' || status === 'started';
};

export const readBackgroundWorkIdentity = (part: unknown): {
    type: BackgroundWorkKind;
    id?: string;
    label?: string;
    agent?: string;
} | undefined => {
    if (!part || typeof part !== 'object') return undefined;
    const toolPart = part as ToolLikePart;
    const name = toolNameOf(toolPart);
    if (!isBackgroundableToolName(name)) return undefined;
    const metadata = toolMetadataOf(toolPart);
    const input = toolInputOf(toolPart);
    if (isTaskToolName(name)) {
        const sessionID = readTaskSessionIdFromRecord(metadata)
            ?? readTaskSessionIdFromRecord(toolStateOf(toolPart))
            ?? readTaskSessionIdFromRecord(input);
        const description = readString(input?.description);
        const agent = readString(input?.agent)
            ?? readString(input?.subagent_type)
            ?? readString(input?.subagentType);
        return {
            type: 'subagent',
            id: sessionID,
            label: description ?? sessionID,
            agent,
        };
    }
    const shellID = readString(metadata?.shellID) ?? readString(toolStateOf(toolPart)?.shellID);
    const jobID = readString(metadata?.jobID) ?? readString(toolStateOf(toolPart)?.jobID);
    const command = readString(input?.command);
    const partID = readString(toolPart.id);
    return {
        type: 'shell',
        id: shellID ?? jobID ?? partID,
        label: command ?? shellID ?? jobID ?? partID,
    };
};

export type ResolveBackgroundToolActivityInput = {
    part: unknown;
    completions?: BackgroundCompletionIndex;
    /**
     * Authoritative child session status for native/plugin subagent rows.
     * Prefer live channels: busy/retry keep background-running; idle settles.
     */
    childSessionStatusType?: string | null;
};

const lookupShellCompletion = (
    identity: { id?: string },
    part: ToolLikePart,
    completions: BackgroundCompletionIndex | undefined,
): BackgroundCompletionState | undefined => {
    if (!completions) return undefined;
    const metadata = toolMetadataOf(part);
    const state = toolStateOf(part);
    const candidates = [
        identity.id,
        readString(metadata?.shellID),
        readString(metadata?.jobID),
        readString(state?.shellID),
        readString(state?.jobID),
        readString(part.id),
    ];
    for (const key of candidates) {
        if (!key) continue;
        const hit = completions.byShellOrJobID.get(key);
        if (hit) return hit;
    }
    return undefined;
};

const lookupChildCompletion = (
    identity: { id?: string },
    completions: BackgroundCompletionIndex | undefined,
): BackgroundCompletionState | undefined => {
    if (!completions || !identity.id) return undefined;
    return completions.byChildSessionID.get(identity.id);
};

/**
 * Resolve live vs final activity for a backgroundable tool row.
 * Status sources (in priority):
 * 1. Foreground tool lifecycle still running → blocking
 * 2. Synthetic completion notice / metadata terminal → terminal (never stay busy)
 * 3. Subagent: authoritative child session status (idle settles; busy keeps live)
 * 4. Settled tool + historical metadata.status=running hint → background-running
 *    only when no terminal fact exists
 * 5. Otherwise settled
 */
export const resolveBackgroundToolActivity = (
    input: ResolveBackgroundToolActivityInput,
): BackgroundToolActivity => {
    const { part, completions, childSessionStatusType } = input;
    if (!part || typeof part !== 'object') return { kind: 'settled' };
    const toolPart = part as ToolLikePart;
    if (toolPart.type !== undefined && toolPart.type !== 'tool') return { kind: 'settled' };
    if (!isBackgroundableToolName(toolNameOf(toolPart))) return { kind: 'settled' };

    if (isBlockingForegroundToolPart(part)) {
        return { kind: 'blocking' };
    }

    const identity = readBackgroundWorkIdentity(part);
    if (!identity) return { kind: 'settled' };

    if (identity.type === 'shell') {
        const terminal = lookupShellCompletion(identity, toolPart, completions);
        if (terminal) return { kind: 'terminal', state: terminal };
        if (hasSettledBackgroundRunningHint(part)) {
            return { kind: 'background-running' };
        }
        return { kind: 'settled' };
    }

    // subagent / task
    const terminal = lookupChildCompletion(identity, completions);
    if (terminal) return { kind: 'terminal', state: terminal };

    const childType = readString(childSessionStatusType)?.toLowerCase();
    if (childType === 'idle') {
        return { kind: 'settled' };
    }
    if (childType === 'busy' || childType === 'retry') {
        return { kind: 'background-running' };
    }

    // No live child status yet: historical running hint may start observation,
    // but must not force permanent busy once a terminal notice arrives (handled above).
    if (hasSettledBackgroundRunningHint(part)) {
        // Without child id we cannot observe live status — treat hint as
        // background-running only while observation may still attach.
        if (!identity.id) return { kind: 'background-running' };
        // Unknown child status with running hint: keep observing as live until
        // idle/terminal facts arrive (ToolPart latches observation).
        return { kind: 'background-running' };
    }

    return { kind: 'settled' };
};

/**
 * Project blocking foreground work and already-detached background work from
 * the parent session transcript. Completion notices clear background entries.
 */
export const projectSessionBackgroundFromMessages = (
    messages: MessageLike[],
): SessionBackgroundProjection => {
    const completions = collectBackgroundCompletions(messages);
    const blocking: SessionBlockingWork[] = [];
    const backgroundTasks: SessionBackgroundTask[] = [];
    const seenBackground = new Set<string>();

    for (const message of messages) {
        if (messageRoleOf(message) !== 'assistant') continue;
        for (const part of partsOfMessage(message)) {
            if (part.type !== undefined && part.type !== 'tool') continue;
            const partID = readString(part.id);
            if (!partID) continue;
            const identity = readBackgroundWorkIdentity(part);
            if (!identity) continue;

            const activity = resolveBackgroundToolActivity({ part, completions });
            if (activity.kind === 'blocking') {
                blocking.push({
                    type: identity.type,
                    partID,
                    id: identity.id,
                    label: identity.label,
                });
                continue;
            }

            if (activity.kind !== 'background-running') continue;
            const taskId = identity.id ?? partID;
            if (seenBackground.has(taskId)) continue;
            seenBackground.add(taskId);
            backgroundTasks.push({
                id: taskId,
                type: identity.type,
                label: identity.label ?? taskId,
                agent: identity.agent,
            });
        }
    }

    return { blocking, backgroundTasks };
};

export const canMoveSessionToBackground = (
    projection: Pick<SessionBackgroundProjection, 'blocking'>,
): boolean => projection.blocking.length > 0;

export type SessionBackgroundClient = {
    session: {
        background: (input: { sessionID: string }) => Promise<unknown>;
    };
};

/**
 * Official contract: POST session.background with the **parent** session id.
 * Detaches every currently blocking backgroundable tool for that session.
 * Idle requests are a server no-op.
 */
export const moveSessionBlockingWorkToBackground = async (
    sessionID: string,
    client: SessionBackgroundClient,
): Promise<{ ok: true } | { ok: false; error: string }> => {
    const id = sessionID.trim();
    if (!id) return { ok: false, error: 'sessionID required' };
    try {
        await client.session.background({ sessionID: id });
        return { ok: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'session.background failed' };
    }
};

/** Shell-specific identity helpers for ToolPart observation scope. */
export const readShellBackgroundIdentity = (part: unknown): {
    shellID?: string;
    jobID?: string;
    workID?: string;
} | undefined => {
    if (!part || typeof part !== 'object') return undefined;
    const toolPart = part as ToolLikePart;
    if (!isShellToolName(toolNameOf(toolPart))) return undefined;
    const metadata = toolMetadataOf(toolPart);
    const state = toolStateOf(toolPart);
    const shellID = readString(metadata?.shellID) ?? readString(state?.shellID);
    const jobID = readString(metadata?.jobID) ?? readString(state?.jobID);
    const partID = readString(toolPart.id);
    return {
        shellID,
        jobID,
        workID: shellID ?? jobID ?? partID,
    };
};
