import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { speechDefaults } from '@/lib/voice/speechSettings';

const mocks = vi.hoisted(() => ({
    transport: 'pc', generation: 0, endpointListeners: new Set<() => void>(),
    eventListeners: new Set<(event: { type: string }) => void>(), fetch: vi.fn(),
    state: {} as Record<string, unknown>, setState: vi.fn(),
}));
vi.mock('@/lib/runtime-switch', () => ({
    getRuntimeTransportIdentity: () => mocks.transport, getRuntimeGeneration: () => mocks.generation,
    isRuntimeEndpointIdentityChange: () => true,
    subscribeRuntimeEndpointChanged: (listener: () => void) => { mocks.endpointListeners.add(listener); return () => { mocks.endpointListeners.delete(listener); }; },
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('@/contexts/runtimeAPIRegistry', () => ({ getRegisteredRuntimeAPIs: () => ({ runtime: { isVSCode: false } }) }));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: (listener: (event: { type: string }) => void) => { mocks.eventListeners.add(listener); return () => { mocks.eventListeners.delete(listener); }; } }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: { getState: () => mocks.state, setState: mocks.setState } }));
import { queryClient } from '@/lib/queryRuntime';
import { mountSpeechSettingsSync } from './speech-settings-sync';

let stop: (() => void) | undefined;
beforeEach(() => {
    queryClient.clear(); mocks.transport = 'pc'; mocks.generation = 0; mocks.state = { ...speechDefaults };
    mocks.setState.mockReset().mockImplementation((patch) => Object.assign(mocks.state, patch));
    mocks.fetch.mockReset();
});
afterEach(() => { stop?.(); stop = undefined; queryClient.clear(); });

it('enables TTS and ASR at cold startup without opening Settings or consulting local storage', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ ...speechDefaults, showMessageTTSButtons: true, voiceProvider: 'volcengine', dictationEnabled: true, sttProvider: 'volcengine', speechRate: 1.3 }));
    stop = mountSpeechSettingsSync();
    await vi.waitFor(() => expect(mocks.state).toMatchObject({ showMessageTTSButtons: true, voiceProvider: 'volcengine', dictationEnabled: true, sttProvider: 'volcengine', speechRate: 1.3 }));
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0][0]).toBe('/api/voice/settings');
});

it('adopts a warm authoritative cache and skips semantically identical projections', () => {
    queryClient.setQueryData(['pc', 'speech', 'settings'], { ...speechDefaults, showMessageTTSButtons: true });
    stop = mountSpeechSettingsSync();
    expect(mocks.state.showMessageTTSButtons).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.setState.mockClear();
    queryClient.setQueryData(['pc', 'speech', 'settings'], { ...speechDefaults, showMessageTTSButtons: true });
    expect(mocks.setState).not.toHaveBeenCalled();
});

it('refreshes both sections on a remote save or reconnect and retains the snapshot on failure', async () => {
    mocks.fetch.mockImplementation(async () => Response.json({ ...speechDefaults, showMessageTTSButtons: true }));
    stop = mountSpeechSettingsSync();
    await vi.waitFor(() => expect(mocks.state.showMessageTTSButtons).toBe(true));
    mocks.fetch.mockImplementation(async () => Response.json({ ...speechDefaults, dictationEnabled: true }));
    for (const listener of mocks.eventListeners) listener({ type: 'speech-settings-changed' });
    await vi.waitFor(() => expect(mocks.state).toMatchObject({ showMessageTTSButtons: false, dictationEnabled: true }));
    mocks.fetch.mockImplementation(async () => new Response('{}', { status: 503 }));
    for (const listener of mocks.eventListeners) listener({ type: 'event-stream-ready' });
    await vi.waitFor(() => expect(queryClient.getQueryState(['pc', 'speech', 'settings'])?.status).toBe('error'), { timeout: 3000 });
    expect(mocks.state.dictationEnabled).toBe(true);
});

it('clears old Host settings immediately and fences a late previous-host fetch', async () => {
    let finish!: (value: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    stop = mountSpeechSettingsSync();
    mocks.state.showMessageTTSButtons = true;
    mocks.fetch.mockImplementation(async () => Response.json(speechDefaults));
    mocks.transport = 'other'; mocks.generation++;
    for (const listener of mocks.endpointListeners) listener();
    expect(mocks.state.showMessageTTSButtons).toBe(false);
    finish(Response.json({ ...speechDefaults, showMessageTTSButtons: true }));
    await vi.waitFor(() => expect(queryClient.getQueryState(['other', 'speech', 'settings'])?.status).toBe('success'));
    expect(mocks.state.showMessageTTSButtons).toBe(false);
});
