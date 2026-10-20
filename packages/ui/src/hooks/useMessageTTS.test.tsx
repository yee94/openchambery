import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useMessageTTS, type UseMessageTTSReturn } from './useMessageTTS';

const mocks = vi.hoisted(() => ({
    config: { voiceProvider: 'volcengine', ttsInputMode: 'raw' },
    speak: vi.fn(), stop: vi.fn(), unlock: vi.fn(), localUnlock: vi.fn(), fetch: vi.fn(),
}));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: Object.assign(
    (selector: (state: typeof mocks.config) => unknown) => selector(mocks.config), { getState: () => mocks.config },
) }));
vi.mock('./useServerTTS', () => ({ useServerTTS: () => ({ speak: mocks.speak, stop: mocks.stop, unlockAudio: mocks.unlock, isAvailable: false }) }));
vi.mock('./useSayTTS', () => ({ useSayTTS: () => ({ stop: () => {}, unlockAudio: async () => {} }) }));
vi.mock('./useLocalTTS', () => ({ useLocalTTS: () => ({ stop: () => {}, unlockAudio: mocks.localUnlock }) }));
vi.mock('@/lib/voice/browserVoiceService', () => ({ browserVoiceService: { cancelSpeech: () => {}, resumeAudioContext: async () => {} } }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
let current: UseMessageTTSReturn;
let root: ReturnType<typeof createRoot>;
function Probe() { current = useMessageTTS({ enabled: true }); return null; }
beforeEach(async () => {
    vi.clearAllMocks(); mocks.config.voiceProvider = 'volcengine'; mocks.config.ttsInputMode = 'raw';
    mocks.speak.mockResolvedValue(undefined);
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
});
afterEach(async () => { await act(async () => root.unmount()); });

it.each(['volcengine', 'openai', 'openai-compatible'])('delegates %s playback to the Host without cached capability gating or configuration', async (provider) => {
    mocks.config.voiceProvider = provider;
    await act(async () => root.render(<Probe />));
    await act(async () => current.play('你好'));
    expect(mocks.speak).toHaveBeenCalledWith('你好', { onEnd: expect.any(Function), onError: expect.any(Function) });
});

it('settles once on audio end, not synthesis completion', async () => {
    const settled = vi.fn();
    await act(async () => current.play('你好', settled));
    expect(settled).not.toHaveBeenCalled();
    const options = mocks.speak.mock.calls[0][1];
    await act(async () => { options.onEnd(); options.onEnd(); });
    expect(settled).toHaveBeenCalledTimes(1);
});

it('stops active speech on Escape and ignores late playback completion', async () => {
    const settled = vi.fn();
    await act(async () => current.play('你好', settled));
    const options = mocks.speak.mock.calls[0][1];
    mocks.stop.mockClear();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    await act(async () => window.dispatchEvent(escape));
    expect(current.isPlaying).toBe(false);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
    await act(async () => options.onEnd());
    expect(settled).not.toHaveBeenCalled();
});

it('does not consume Escape while idle or during IME composition', async () => {
    const idleEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    await act(async () => window.dispatchEvent(idleEscape));
    expect(idleEscape.defaultPrevented).toBe(false);
    expect(mocks.stop).not.toHaveBeenCalled();
    await act(async () => current.play('你好'));
    mocks.stop.mockClear();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true })));
    expect(current.isPlaying).toBe(true);
    expect(mocks.stop).not.toHaveBeenCalled();
});

it('does not play a summary that resolves after cancellation', async () => {
    mocks.config.ttsInputMode = 'summarized';
    await act(async () => root.render(<Probe />));
    let resolve!: (response: Response) => void;
    mocks.fetch.mockReturnValue(new Promise((done) => { resolve = done; }));
    let playing!: Promise<void>;
    await act(async () => { playing = current.play('很长的回复'.repeat(200)); });
    await act(async () => current.stop());
    await act(async () => { resolve(Response.json({ text: '迟到的摘要' })); await playing; });
    expect(mocks.speak).not.toHaveBeenCalled();
});

it('unlocks the configured local audio context on the enabling gesture', async () => {
    mocks.config.voiceProvider = 'local';
    await act(async () => root.render(<Probe />));
    await act(async () => current.unlock());
    expect(mocks.localUnlock).toHaveBeenCalledTimes(1);
    expect(mocks.unlock).not.toHaveBeenCalled();
});
