import { useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { withConfigQueryDeadline } from './configQueryDeadline';

export interface VolcengineSpeechSettings {
    configured: boolean;
    voice: string;
    resourceId: string;
    asrResourceId: string;
}

export type VolcengineSpeechPatch = Partial<Omit<VolcengineSpeechSettings, 'configured'>> & { apiKey?: string };

function parseSettings(value: unknown): VolcengineSpeechSettings {
    if (!value || typeof value !== 'object' || !('configured' in value) || typeof value.configured !== 'boolean'
        || !('voice' in value) || typeof value.voice !== 'string'
        || !('resourceId' in value) || typeof value.resourceId !== 'string'
        || !('asrResourceId' in value) || typeof value.asrResourceId !== 'string') {
        throw new Error('Invalid speech settings response');
    }
    return { configured: value.configured, voice: value.voice, resourceId: value.resourceId, asrResourceId: value.asrResourceId };
}

const volcengineSpeechQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
    queryKey: [transport, 'speech', 'volcengine'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => withConfigQueryDeadline(signal, async (signal) => {
        const response = await runtimeFetch('/api/voice/volcengine', { signal });
        if (!response.ok) throw new Error('Unable to load speech settings');
        return parseSettings(await response.json());
    }),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: true,
});

export const useVolcengineSpeechQuery = () => useQuery(volcengineSpeechQueryOptions());

export async function saveVolcengineSpeechSettings(patch: VolcengineSpeechPatch): Promise<VolcengineSpeechSettings> {
    const transport = getRuntimeTransportIdentity();
    const generation = getRuntimeGeneration();
    const { queryKey } = volcengineSpeechQueryOptions(transport);
    await queryClient.cancelQueries({ queryKey, exact: true });
    if (generation !== getRuntimeGeneration()) throw new Error('Runtime changed');
    const settings = await withConfigQueryDeadline(new AbortController().signal, async (signal) => {
        const response = await runtimeFetch('/api/voice/volcengine', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
            signal,
        });
        if (!response.ok) throw new Error('Unable to save speech settings');
        return parseSettings(await response.json());
    });
    if (generation !== getRuntimeGeneration() || transport !== getRuntimeTransportIdentity()) throw new Error('Runtime changed');
    await queryClient.cancelQueries({ queryKey, exact: true });
    if (generation !== getRuntimeGeneration()) throw new Error('Runtime changed');
    queryClient.setQueryData(queryKey, settings);
    return settings;
}
