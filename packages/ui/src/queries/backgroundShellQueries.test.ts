import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { opencodeClient } from '@/lib/opencode/client';
import { backgroundShellQueryOptions, backgroundShellOutputQueryOptions } from './backgroundShellQueries';

vi.hoisted(() => vi.stubGlobal('fetch', vi.fn(async () => Response.json({}))));
afterEach(() => vi.restoreAllMocks());

test('scopes shell requests, forwards abort, and preserves last successful data on failure', async () => {
    const list = vi.fn(async () => ({ data: [{ id: 'wanted', status: 'running' }, { id: 'other', status: 'running' }] }));
    const output = vi.fn(async () => ({ data: { output: 'log', truncated: false, cursor: 3, size: 3 } }));
    const scoped = vi.spyOn(opencodeClient, 'getScopedSdkClient').mockReturnValue({ shell: { list, output } } as unknown as ReturnType<typeof opencodeClient.getScopedSdkClient>);
    const client = new QueryClient();
    const options = { ...backgroundShellQueryOptions('/workspace', ['wanted']), retry: false, staleTime: 0 };
    try {
        const data = await client.fetchQuery(options);
        expect(data).toEqual([{ id: 'wanted', status: 'running' }]);
        expect(scoped).toHaveBeenCalledWith('/workspace');
        expect(list).toHaveBeenCalledWith({ location: { directory: '/workspace' } }, { signal: expect.any(AbortSignal) });
        list.mockRejectedValueOnce(new Error('unavailable'));
        await expect(client.fetchQuery(options)).rejects.toThrow('unavailable');
        expect(client.getQueryData(options.queryKey)).toBe(data);
        list.mockResolvedValueOnce({ data: [] });
        expect(await client.fetchQuery(options)).toEqual([]);
        await client.fetchQuery(backgroundShellOutputQueryOptions('/workspace', 'wanted'));
        expect(output).toHaveBeenCalledWith({ id: 'wanted', location: { directory: '/workspace' }, limit: 65_536 }, { signal: expect.any(AbortSignal) });
        expect(backgroundShellQueryOptions('/other', ['wanted']).queryKey).not.toEqual(options.queryKey);
    } finally { client.clear(); }
});
