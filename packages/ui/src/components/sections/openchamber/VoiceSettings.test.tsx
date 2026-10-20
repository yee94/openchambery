import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
    transport: 'host-a', generation: 0, listeners: new Set<() => void>(), fetch: vi.fn(),
    toastError: vi.fn(), speak: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: runtime.toastError } }));
vi.mock('@/lib/runtime-switch', () => ({
    getRuntimeTransportIdentity: () => runtime.transport, getRuntimeGeneration: () => runtime.generation,
    isRuntimeEndpointIdentityChange: () => true,
    subscribeRuntimeEndpointChanged: (listener: () => void) => { runtime.listeners.add(listener); return () => { runtime.listeners.delete(listener); }; },
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: runtime.fetch }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/hooks/useServerTTS', () => ({ useServerTTS: () => ({ speak: runtime.speak, stop: vi.fn(), isPlaying: false, error: null }) }));
vi.mock('@/hooks/useLocalTTS', () => ({ useLocalTTS: () => ({ speak: vi.fn(), stop: vi.fn(), isPlaying: false, error: null }) }));
vi.mock('@/lib/voice/browserVoiceService', () => ({ browserVoiceService: { waitForVoices: async () => [], cancelSpeech() {} } }));
vi.mock('@/components/dictation/DictationTestDialog', () => ({ DictationTestDialog: () => <div role="dialog" /> }));
vi.mock('@/components/ui/select', () => ({
    Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectContent: () => null, SelectItem: () => null, SelectTrigger: () => null, SelectValue: () => null,
}));
vi.mock('@/components/ui/checkbox', () => ({ Checkbox: ({ checked, onChange, ariaLabel }: { checked: boolean; onChange: (value: boolean) => void; ariaLabel: string }) => <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} aria-label={ariaLabel} /> }));

import { queryClient } from '@/lib/queryRuntime';
import { speechDefaults, speechSecretFields } from '@/lib/voice/speechSettings';
import { VoiceSettings } from './VoiceSettings';

let saved = { ...speechDefaults, showMessageTTSButtons: true, voiceProvider: 'volcengine' as const, dictationEnabled: true, sttProvider: 'volcengine' as const };
let container: HTMLDivElement;
let root: Root;
const writes: Record<string, unknown>[] = [];
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); }); };
const section = (mode: 'tts' | 'asr') => container.querySelector(`[data-settings-item="voice.${mode === 'tts' ? 'playback' : 'speech-recognition'}"]`)!;
const button = (mode: 'tts' | 'asr', key = 'settings.voice.volcengine.save') => Array.from(section(mode).querySelectorAll('button')).find((node) => node.textContent === key)!;
const keyInput = (mode: 'tts' | 'asr') => section(mode).querySelector('input[type="password"]') as HTMLInputElement;
const editKey = async (mode: 'tts' | 'asr', value: string) => {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(keyInput(mode), value);
        keyInput(mode).dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const mount = async () => {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><VoiceSettings /></QueryClientProvider>));
    await flush();
};

beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    runtime.transport = 'host-a'; runtime.generation = 0;
    queryClient.clear(); writes.length = 0; runtime.toastError.mockClear(); runtime.speak.mockClear();
    saved = { ...speechDefaults, showMessageTTSButtons: true, voiceProvider: 'volcengine', dictationEnabled: true, sttProvider: 'volcengine' };
    runtime.fetch.mockReset().mockImplementation(async (path: string, options?: RequestInit) => {
        if (path !== '/api/voice/settings') return Response.json({ available: false, voices: [] });
        if (options?.method === 'PUT') {
            const patch = JSON.parse(options.body as string);
            writes.push(patch);
            const { apiKey, ...preferences } = patch;
            saved = { ...saved, ...preferences, configured: apiKey === undefined ? saved.configured : Boolean(apiKey) };
        }
        return Response.json(Object.fromEntries(Object.entries(saved).filter(([key]) => !speechSecretFields.has(key))));
    });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); queryClient.clear(); onlineManager.setOnline(true); vi.restoreAllMocks(); localStorage.clear(); });

describe('Host-backed speech settings', () => {
    it('renders the settings immediately and attempts Host reads even when the mobile browser reports offline', async () => {
        onlineManager.setOnline(false);
        let complete!: (response: Response) => void;
        runtime.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
        await mount();
        expect(section('tts')).not.toBeNull();
        expect(section('asr')).not.toBeNull();
        expect(button('tts').disabled).toBe(false);
        expect(runtime.fetch).toHaveBeenCalledWith('/api/voice/settings', expect.anything());
        await act(async () => complete(Response.json(saved))); await flush();
        expect((section('tts').querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    });
    it('loads both enabled sections from the Host and ignores obsolete local values', async () => {
        localStorage.setItem('showMessageTTSButtons', 'false');
        localStorage.setItem('voiceProvider', 'browser');
        localStorage.setItem('volcengine-speech', JSON.stringify({ state: { apiKey: 'obsolete-local-key' } }));
        const storageRead = vi.spyOn(Storage.prototype, 'getItem');
        const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
        await mount();
        expect((section('tts').querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
        expect((section('asr').querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
        expect(keyInput('tts').value).toBe('');
        expect(storageRead).not.toHaveBeenCalledWith('showMessageTTSButtons');
        expect(storageRead).not.toHaveBeenCalledWith('volcengine-speech');
        expect(storageWrite).not.toHaveBeenCalled();
    });

    it('saves only its section while retaining edits in the other section', async () => {
        await mount();
        await act(async () => {
            (section('tts').querySelector('input[type="checkbox"]') as HTMLInputElement).click();
            (section('asr').querySelector('input[type="checkbox"]') as HTMLInputElement).click();
        });
        expect(writes).toHaveLength(0);
        await act(async () => button('tts').click()); await flush();
        expect(writes).toEqual([{ showMessageTTSButtons: false }]);
        expect(saved.dictationEnabled).toBe(true);
        await act(async () => button('asr').click()); await flush();
        expect(writes.at(-1)).toEqual({ dictationEnabled: false });
        expect(button('tts').disabled).toBe(false);
        expect(button('asr').disabled).toBe(false);
    });

    it.each(['tts', 'asr'] as const)('saves %s drafts before starting a test', async (mode) => {
        await mount(); await editKey(mode, 'test-key');
        const target = button(mode, mode === 'asr' ? 'settings.voice.volcengine.asrTest' : 'settings.voice.page.actions.preview');
        let complete!: (value: Response) => void;
        runtime.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
        await act(async () => target.click()); await flush();
        expect(target.disabled).toBe(true);
        expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(runtime.speak).not.toHaveBeenCalled();
        expect(runtime.fetch.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ apiKey: 'test-key' }) });
        await act(async () => complete(Response.json({ ...saved, configured: true }))); await flush();
        if (mode === 'asr') expect(container.querySelector('[role="dialog"]')).not.toBeNull();
        else expect(runtime.speak).toHaveBeenCalledOnce();
        expect(keyInput(mode).value).toBe('');
        expect(keyInput(mode).placeholder).toBe('••••••••');
    });

    it('preserves inputs on failed saving and allows testing to retry', async () => {
        await mount(); await editKey('asr', 'test-key');
        runtime.fetch.mockResolvedValueOnce(new Response('{}', { status: 500 }));
        await act(async () => button('asr', 'settings.voice.volcengine.asrTest').click()); await flush();
        expect(runtime.toastError).toHaveBeenCalled(); expect(keyInput('asr').value).toBe('test-key');
        expect(container.querySelector('[role="dialog"]')).toBeNull();
        await act(async () => button('asr', 'settings.voice.volcengine.asrTest').click()); await flush();
        expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it('does not start a late test on a different Host', async () => {
        await mount(); await editKey('asr', 'test-key');
        let complete!: (value: Response) => void;
        runtime.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
        await act(async () => button('asr', 'settings.voice.volcengine.asrTest').click()); await flush();
        await act(async () => { runtime.transport = 'host-b'; runtime.generation++; for (const listener of runtime.listeners) listener(); }); await flush();
        await act(async () => complete(Response.json({ ...saved, configured: true }))); await flush();
        expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(runtime.toastError).not.toHaveBeenCalled();
        expect(keyInput('asr').value).toBe('');
    });
});
