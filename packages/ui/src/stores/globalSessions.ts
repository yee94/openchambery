import type { OpenCodeClient, Session, SessionInfo } from '@/lib/opencode/v2-types';
import { projectSession } from "@/lib/opencode/v2-types";
import { retry } from "@/sync/retry";
import { stripSessionListDetails } from "@/sync/sanitize";

export type GlobalSessionRecord = Session & {
    project?: {
        id: string;
        name?: string;
        worktree?: string;
    } | null;
};

const HIDDEN_SESSION_TITLES = new Set(['smartfetch-secondary']);

const nonEmptySystemID = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0;

/**
 * System sessions are isolated by authoritative OpenChamber metadata only.
 * Title prefixes are human-facing labels and never participate in this check.
 */
export const isSystemOwnedSession = (
    session: { metadata?: Session['metadata'] | Record<string, unknown> | null },
): boolean => {
    const metadata = session.metadata;
    if (!metadata || typeof metadata !== 'object') return false;
    const openchamber = (metadata as { openchamber?: unknown }).openchamber;
    if (!openchamber || typeof openchamber !== 'object') return false;
    const record = openchamber as {
        assistant?: { assistantID?: unknown };
        scheduledTask?: { taskID?: unknown };
    };
    if (nonEmptySystemID(record.assistant?.assistantID)) return true;
    if (nonEmptySystemID(record.scheduledTask?.taskID)) return true;
    return false;
};

const getSessionParentID = (
    session: { parentID?: string | null },
): string | null => {
    const parentID = session.parentID;
    return typeof parentID === 'string' && parentID.trim() ? parentID : null;
};

export const isVisibleGlobalSession = (
    session: Pick<Session, 'title'> & {
        parentID?: string | null;
        metadata?: Session['metadata'] | Record<string, unknown> | null;
    },
): boolean => {
    if (session.title && HIDDEN_SESSION_TITLES.has(session.title)) return false;
    // Subagent/child sessions never belong in the sidebar root catalog. They
    // load only when the user expands a parent tree node; promoting orphans
    // (parent archived, system-owned, or simply missing from this list) is how
    // scheduled-task subagents used to leak into the project list.
    if (getSessionParentID(session)) return false;
    if (isSystemOwnedSession(session)) return false;
    return true;
};

const sessionUpdatedAt = (session: { time?: { updated?: number } }): number => {
    const updated = session.time?.updated;
    return typeof updated === "number" && Number.isFinite(updated) ? updated : 0;
};

const isArchivedSession = (session: { time?: { archived?: number } }): boolean =>
    typeof session.time?.archived === "number";

/** Project a v2 list row and keep a directory fallback for fixture/legacy rows. */
const projectListedSession = (info: SessionInfo & { directory?: string }): GlobalSessionRecord => {
    const projected = projectSession(info);
    return stripSessionListDetails({
        ...projected,
        directory: projected.directory || info.directory,
    }) as GlobalSessionRecord;
};

export async function listGlobalSessionPages(
    apiClient: OpenCodeClient,
    options: {
        directory?: string;
        archived: boolean;
        roots?: boolean;
        /** Include only sessions updated at or after this timestamp. */
        start?: number;
        cursor?: number;
        pageSize: number;
        /** Stop after collecting this many sessions. Omit for a full paginated load. */
        maxItems?: number;
        /** Per-page request budget. The proxy's generic timeout is intentionally much longer. */
        timeoutMs?: number;
        /** Bounded retry budget for this page. Directory cold-start loads use two attempts. */
        retryAttempts?: number;
        signal?: AbortSignal;
        onPage?: (sessions: GlobalSessionRecord[]) => void;
    },
): Promise<GlobalSessionRecord[]> {
    const all: GlobalSessionRecord[] = [];
    const seenIds = new Set<string>();
    const beforeUpdated = options.cursor;
    let v2Cursor: string | undefined;

    while (true) {
        const remaining = options.maxItems === undefined
            ? options.pageSize
            : Math.max(0, options.maxItems - all.length);
        if (remaining === 0) break;
        const requestLimit = Math.min(options.pageSize, remaining);
        const page = await retry(async () => {
            const timeoutSignal = options.timeoutMs === undefined
                ? undefined
                : AbortSignal.timeout(options.timeoutMs);
            const requestSignal = options.signal && timeoutSignal
                ? AbortSignal.any([options.signal, timeoutSignal])
                : options.signal ?? timeoutSignal;
            const result = await apiClient.session.list({
                ...(options.directory ? { directory: options.directory } : {}),
                ...(options.roots === true ? { parentID: null } : {}),
                limit: requestLimit,
                ...(v2Cursor ? { cursor: v2Cursor } : {}),
            }, requestSignal ? { signal: requestSignal } : undefined);
            if (!result || !Array.isArray(result.data)) {
                const error = new Error("session.list returned no data");
                (error as Error & { status?: number }).status = 503;
                throw error;
            }
            return result;
        }, { attempts: options.retryAttempts ?? 3, delay: 500 });

        const raw = page.data.map((session) => projectListedSession(session));
        if (raw.length === 0) break;

        const payload = raw.filter((session) => {
            if (options.archived ? !isArchivedSession(session) : isArchivedSession(session)) {
                return false;
            }
            if (options.start !== undefined && sessionUpdatedAt(session) < options.start) {
                return false;
            }
            if (beforeUpdated !== undefined && sessionUpdatedAt(session) >= beforeUpdated) {
                return false;
            }
            return isVisibleGlobalSession(session);
        });

        let appended = 0;
        for (const session of payload) {
            if (!session?.id || seenIds.has(session.id)) continue;
            seenIds.add(session.id);
            all.push(session);
            appended += 1;
        }
        if (appended > 0) {
            options.onPage?.(payload);
        }
        if (options.maxItems !== undefined && all.length >= options.maxItems) break;

        // Filtered-empty pages are not exhausted — keep walking the raw cursor.
        if (raw.length < requestLimit) break;

        const nextCursor = typeof page.cursor?.next === "string" && page.cursor.next.length > 0
            ? page.cursor.next
            : undefined;
        if (!nextCursor || nextCursor === v2Cursor) break;
        v2Cursor = nextCursor;
    }

    return all;
}
