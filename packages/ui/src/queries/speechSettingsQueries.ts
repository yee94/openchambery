import { useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { withConfigQueryDeadline } from './configQueryDeadline';
import { parseSpeechSettings, type SpeechSettings, type SpeechSettingsPatch } from '@/lib/voice/speechSettings';

export const speechSettingsQueryOptions = (transport = getRuntimeTransportIdentity()) => ({
    queryKey: [transport, 'speech', 'settings'] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => withConfigQueryDeadline(signal, async (signal) => {
        const response = await runtimeFetch('/api/voice/settings', { signal });
        if (!response.ok) throw new Error('Unable to load speech settings');
        return parseSpeechSettings(await response.json());
    }),
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: true,
});

export const useSpeechSettingsQuery = () => useQuery(speechSettingsQueryOptions());

export async function saveSpeechSettings(patch: SpeechSettingsPatch, generation = getRuntimeGeneration(), transport = getRuntimeTransportIdentity()): Promise<SpeechSettings> {
    const { queryKey } = speechSettingsQueryOptions(transport);
    await queryClient.cancelQueries({ queryKey, exact: true });
    if (generation !== getRuntimeGeneration()) throw new Error('Runtime changed');
    const settings = await withConfigQueryDeadline(new AbortController().signal, async (signal) => {
        const response = await runtimeFetch('/api/voice/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
            signal,
        });
        if (!response.ok) throw new Error('Unable to save speech settings');
        return parseSpeechSettings(await response.json());
    });
    if (generation !== getRuntimeGeneration() || transport !== getRuntimeTransportIdentity()) throw new Error('Runtime changed');
    await queryClient.cancelQueries({ queryKey, exact: true });
    if (generation !== getRuntimeGeneration()) throw new Error('Runtime changed');
    queryClient.setQueryData(queryKey, settings);
    return settings;
}
