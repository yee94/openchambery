import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
    transport: 'host-a', generation: 0, listeners: new Set<() => void>(), fetch: vi.fn(),
    toastError: vi.fn(),
    speak: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: runtime.toastError } }));
vi.mock('@/lib/runtime-switch', () => ({
    getRuntimeTransportIdentity: () => runtime.transport,
    getRuntimeGeneration: () => runtime.generation,
    isRuntimeEndpointIdentityChange: () => true,
    subscribeRuntimeEndpointChanged: (listener: () => void) => {
        runtime.listeners.add(listener);
        return () => { runtime.listeners.delete(listener); };
    },
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: runtime.fetch }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useServerTTS', () => ({ useServerTTS: () => ({ speak: runtime.speak, stop: vi.fn(), isPlaying: false, error: null }) }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: { getState: () => ({}) } }));
vi.mock('@/components/dictation/DictationTestDialog', () => ({ DictationTestDialog: () => <div role="dialog" /> }));
vi.mock('@/components/ui/select', () => ({
    Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectContent: () => null,
    SelectItem: () => null,
    SelectTrigger: () => null,
    SelectValue: () => null,
}));

import { queryClient } from '@/lib/queryRuntime';
import { useVolcengineSpeechStore } from '@/stores/useVolcengineSpeechStore';
import { VolcengineSpeechSettings } from './VolcengineSpeechSettings';

const defaults = { configured: false, voice: 'zh_female_vv_uranus_bigtts', resourceId: 'seed-tts-2.0', asrResourceId: 'volc.seedasr.sauc.duration' };
let saved = { ...defaults };
let container: HTMLDivElement;
let root: Root;
const writes: Record<string, string>[] = [];
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };
const button = (key: string) => Array.from(container.querySelectorAll('button')).find((node) => node.textContent === key)!;
const keyInput = () => container.querySelector('input[type="password"]') as HTMLInputElement;
const mount = async (mode: 'tts' | 'asr' = 'tts') => {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><VolcengineSpeechSettings mode={mode} /></QueryClientProvider>));
    await flush();
};

beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    runtime.transport = 'host-a';
    runtime.generation = 0;
    queryClient.clear();
    writes.length = 0;
    runtime.toastError.mockClear();
    runtime.speak.mockClear();
    saved = { ...defaults };
    runtime.fetch.mockReset().mockImplementation(async (_path: string, options?: RequestInit) => {
        if (options?.method === 'PUT') {
            const patch = JSON.parse(options.body as string);
            writes.push(patch);
            const { apiKey, ...preferences } = patch;
            saved = { ...saved, ...preferences, configured: apiKey === undefined ? saved.configured : Boolean(apiKey) };
        }
        return Response.json(saved);
    });
    useVolcengineSpeechStore.setState({ apiKey: '', voice: defaults.voice, resourceId: defaults.resourceId, asrResourceId: defaults.asrResourceId });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    queryClient.clear();
    localStorage.removeItem('volcengine-speech');
});

describe('Host-backed speech settings', () => {
    it.each(['tts', 'asr'] as const)('saves pending %s settings before starting the test', async (mode) => {
        useVolcengineSpeechStore.getState().setApiKey('legacy-test-key');
        await mount(mode);
        const testButton = button(mode === 'asr' ? 'settings.voice.volcengine.asrTest' : 'settings.voice.page.actions.preview');
        expect(testButton.disabled).toBe(false);
        let complete!: (response: Response) => void;
        runtime.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
        await act(async () => testButton.click());
        await flush();
        expect(testButton.disabled).toBe(true);
        expect(runtime.fetch.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'PUT', body: expect.stringContaining('legacy-test-key') });
        expect(container.querySelector('[role="dialog"]')).toBeNull();
        expect(runtime.speak).not.toHaveBeenCalled();
        await act(async () => complete(Response.json({ ...defaults, configured: true })));
        await flush();
        if (mode === 'asr') expect(container.querySelector('[role="dialog"]')).not.toBeNull();
        else expect(runtime.speak).toHaveBeenCalledOnce();
        expect(useVolcengineSpeechStore.getState().apiKey).toBe('');
    });

    it('keeps microphone testing retryable when automatic saving fails', async () => {
        useVolcengineSpeechStore.getState().setApiKey('legacy-test-key');
        await mount('asr');
        runtime.fetch.mockResolvedValueOnce(new Response('{}', { status: 500 }));
        await act(async () => button('settings.voice.volcengine.asrTest').click());
        expect(runtime.toastError).toHaveBeenCalledWith('settings.voice.volcengine.saveFailed');
        expect(container.querySelector('[role="dialog"]')).toBeNull();
        expect(keyInput().value).toBe('legacy-test-key');
        expect(button('settings.voice.volcengine.asrTest').disabled).toBe(false);
        await act(async () => button('settings.voice.volcengine.asrTest').click());
        await flush();
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    });
    it.each(['tts', 'asr'] as const)('keeps legacy %s credentials pending until explicit save, then shows server confirmation', async (mode) => {
        useVolcengineSpeechStore.getState().setApiKey('legacy-test-key');
        await mount(mode);
        expect(keyInput().value).toBe('legacy-test-key');
        expect(writes).toHaveLength(0);
        expect(button('settings.voice.volcengine.save').disabled).toBe(false);
        await act(async () => button('settings.voice.volcengine.save').click());
        await flush();
        expect(writes).toHaveLength(1);
        expect(writes[0].apiKey).toBe('legacy-test-key');
        expect(writes[0]).toMatchObject({ voice: defaults.voice, resourceId: defaults.resourceId, asrResourceId: defaults.asrResourceId });
        expect(button('settings.voice.volcengine.save').disabled).toBe(false);
        expect(keyInput().placeholder).toBe('••••••••');
        expect(keyInput().value).toBe('');
        expect(useVolcengineSpeechStore.getState().apiKey).toBe('');
    });

    it('retains the draft and legacy key after failure and only confirms a successful retry', async () => {
        useVolcengineSpeechStore.getState().setApiKey('legacy-test-key');
        await mount();
        runtime.fetch.mockResolvedValueOnce(new Response('{}', { status: 500 }));
        await act(async () => button('settings.voice.volcengine.save').click());
        expect(runtime.toastError).toHaveBeenCalledWith('settings.voice.volcengine.saveFailed');
        expect(button('settings.voice.volcengine.save').disabled).toBe(false);
        expect(keyInput().value).toBe('legacy-test-key');
        expect(useVolcengineSpeechStore.getState().apiKey).toBe('legacy-test-key');
        await act(async () => button('settings.voice.volcengine.save').click());
        await flush();
        expect(button('settings.voice.volcengine.save').disabled).toBe(false);
    });

    it('shows a configured mobile client with no local key and clears only after Save', async () => {
        saved.configured = true;
        await mount('asr');
        expect(keyInput().value).toBe('');
        expect(keyInput().placeholder).toBe('••••••••');
        expect(button('settings.voice.volcengine.asrTest').disabled).toBe(false);
        for (const value of ['replacement-key', '']) {
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(keyInput(), value);
                keyInput().dispatchEvent(new Event('input', { bubbles: true }));
            });
        }
        expect(saved.configured).toBe(true);
        expect(writes).toHaveLength(0);
        await act(async () => button('settings.voice.volcengine.save').click());
        await flush();
        expect(writes).toEqual([{ apiKey: '' }]);
        expect(saved.configured).toBe(false);
        expect(button('settings.voice.volcengine.asrTest').disabled).toBe(false);
        await act(async () => button('settings.voice.volcengine.asrTest').click());
        expect(runtime.toastError).toHaveBeenCalledWith('settings.providers.page.toast.apiKeyRequired');
        expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    it('fences a pending save across runtime switches and does not erase the migration source', async () => {
        useVolcengineSpeechStore.getState().setApiKey('legacy-test-key');
        await mount('asr');
        let complete!: (response: Response) => void;
        runtime.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
        await act(async () => button('settings.voice.volcengine.asrTest').click());
        await flush();
        expect(button('settings.voice.volcengine.save').getAttribute('aria-busy')).toBe('true');
        expect(keyInput().disabled).toBe(true);
        await act(async () => {
            runtime.transport = 'host-b';
            runtime.generation += 1;
            for (const listener of runtime.listeners) listener();
        });
        await flush();
        await act(async () => complete(Response.json({ ...defaults, configured: true })));
        await flush();
        expect(button('settings.voice.volcengine.save').getAttribute('aria-busy')).toBe('false');
        expect(keyInput().placeholder).toBe('API Key');
        expect(useVolcengineSpeechStore.getState().apiKey).toBe('legacy-test-key');
        expect(queryClient.getQueryData(['host-b', 'speech', 'volcengine'])).toMatchObject({ configured: false });
        expect(runtime.toastError).not.toHaveBeenCalled();
        expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    it('does not start playback when the form closes during automatic saving', async () => {
        useVolcengineSpeechStore.getState().setApiKey('legacy-test-key');
        await mount('tts');
        let complete!: (response: Response) => void;
        runtime.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
        await act(async () => button('settings.voice.page.actions.preview').click());
        await act(async () => root.render(null));
        await act(async () => complete(Response.json({ ...defaults, configured: true })));
        expect(runtime.speak).not.toHaveBeenCalled();
        expect(runtime.toastError).not.toHaveBeenCalled();
    });

    it('retains the configured snapshot on refresh failure and exposes a retry', async () => {
        saved.configured = true;
        await mount();
        runtime.fetch.mockResolvedValueOnce(new Response('{}', { status: 500 }));
        await act(async () => { await queryClient.invalidateQueries({ queryKey: ['host-a', 'speech', 'volcengine'] }); });
        await flush();
        expect(container.textContent).toContain('settings.voice.volcengine.loadFailed');
        expect(keyInput().placeholder).toBe('••••••••');
        await act(async () => button('settings.voice.volcengine.retry').click());
        await flush();
        expect(container.textContent).not.toContain('settings.voice.volcengine.loadFailed');
    });
});
