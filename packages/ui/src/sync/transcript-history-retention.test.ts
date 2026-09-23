import { afterEach, describe, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createQueryTranscriptRepository } from './transcript-repository-query-adapter';
import { normalizeSessionProjectionPage } from './session-projection-api';
import { SessionMessageHttpError } from './session-message-query';
import type { TranscriptTransportPage } from './transcript-repository';

const scope = { directory: '/workspace', sessionID: 'ses_retention' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function setup() {
    const rows = Array.from({ length: 65 }, (_, i) => ({
        id: `msg_${String(i).padStart(3, '0')}`, type: 'user',
        time: { created: i + 1 }, text: `original body ${i}`,
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const flights: Array<{ before?: string; settle: () => void }> = [];
    const controls = { hold: false, fail: false, repeatCursor: false };
    const fetcher = vi.fn(async ({ before }: { before?: string }) => {
        if (controls.fail) throw new SessionMessageHttpError(400);
        const end = before ? Number(before.slice(4)) : rows.length;
        const start = Math.max(0, end - 20);
        // Clone like HTTP: do not accidentally pass retention by shared object identity.
        const raw = JSON.parse(JSON.stringify(rows.slice(start, end).reverse()));
        const page = normalizeSessionProjectionPage({ data: raw, cursor: {
            next: controls.repeatCursor ? before : `cur_${start}`, previous: `cur_${end}`,
        } }, scope.sessionID);
        if (!controls.hold) return page;
        return new Promise<TranscriptTransportPage>((resolve) => flights.push({ before, settle: () => resolve(page) }));
    });
    const repo = createQueryTranscriptRepository({
        client, transport: 'retention-runtime', generation: 1, fetcher,
        probe: { getTransport: () => 'retention-runtime', getGeneration: () => 1 },
    });
    cleanups.push(() => { repo.destroy(); client.clear(); });
    const assertRows = (start: number) => {
        const snapshot = repo.getTranscript(scope);
        for (const row of rows.slice(start)) {
            expect(snapshot.messageOrder).toContain(row.id);
            expect(snapshot.partsByMessageID[row.id]?.some(part => part.type === 'text' && part.text === row.text)).toBe(true);
        }
        expect(new Set(snapshot.messageOrder).size).toBe(snapshot.messageOrder.length);
        expect(snapshot.messageOrder.filter(id => rows.some(row => row.id === id))).toEqual(rows.slice(start).map(row => row.id));
    };
    return { repo, rows, controls, flights, fetcher, assertRows };
}

describe('loaded transcript history retention through production Query ownership', () => {
    test('four pages keep every message/body; tail refresh and repeated initial ensure do not shrink history', async () => {
        const { repo, assertRows, fetcher } = setup();
        await repo.ensureInitial(scope);
        assertRows(45);
        for (const start of [25, 5, 0]) {
            await repo.fetchPreviousPage(scope);
            assertRows(start);
        }
        expect(repo.getPagination(scope).boundary.kind).toBe('exhausted');
        const calls = fetcher.mock.calls.length;
        await repo.fetchPreviousPage(scope);
        expect(fetcher).toHaveBeenCalledTimes(calls);
        await repo.refreshFromAuthority(scope);
        await repo.ensureInitial(scope);
        assertRows(0);
        expect(repo.getPagination(scope).boundary.kind).toBe('exhausted');
    });

    test.each(['refresh-first', 'prepend-first'] as const)('%s: concurrent prepend, stale tail refresh and live send keep both history and the live row', async (order) => {
        const { repo, controls, flights, assertRows } = setup();
        await repo.ensureInitial(scope);
        await repo.fetchPreviousPage(scope);
        controls.hold = true;
        const older = repo.fetchPreviousPage(scope);
        const refresh = repo.refreshFromAuthority(scope);
        await vi.waitFor(() => expect(flights).toHaveLength(2));
        const live = normalizeSessionProjectionPage({ data: [{ id: 'msg_live', type: 'user', time: { created: 100 }, text: 'live send' }] }, scope.sessionID).records[0]!;
        repo.apply(scope, { type: 'optimistic-add', message: live.info, parts: live.parts ?? [] });
        const first = flights.find(flight => order === 'refresh-first' ? !flight.before : Boolean(flight.before))!;
        const second = flights.find(flight => flight !== first)!;
        first.settle();
        await (order === 'refresh-first' ? refresh : older);
        assertRows(order === 'refresh-first' ? 25 : 5);
        second.settle();
        await Promise.all([older, refresh]);
        assertRows(5);
        expect(repo.getTranscript(scope).messageOrder.at(-1)).toBe('msg_live');
        expect(repo.getParts(scope, 'msg_live').some(part => part.type === 'text' && part.text === 'live send')).toBe(true);
    });

    test('failed and stationary older pages preserve loaded bodies and cursor, then retry can progress', async () => {
        const { repo, controls, assertRows } = setup();
        await repo.ensureInitial(scope);
        await repo.fetchPreviousPage(scope);
        const cursor = repo.getPagination(scope).cursor;
        controls.fail = true;
        await expect(repo.fetchPreviousPage(scope)).rejects.toThrow();
        await expect(repo.refreshFromAuthority(scope)).rejects.toThrow();
        assertRows(25);
        expect(repo.getPagination(scope).cursor).toBe(cursor);
        controls.fail = false;
        controls.repeatCursor = true;
        await expect(repo.fetchPreviousPage(scope)).rejects.toThrow();
        assertRows(25);
        expect(repo.getPagination(scope).cursor).toBe(cursor);
        controls.repeatCursor = false;
        await repo.fetchPreviousPage(scope);
        assertRows(5);
    });
});
