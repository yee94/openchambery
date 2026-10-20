import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useDictationAudioSource, type DictationAudioSource } from './use-dictation-audio-source';
import { prepareSpeechPlayback } from '../voice/audio-session';

afterEach(() => vi.unstubAllGlobals());

it('can capture after playback has left the iOS session in playback mode', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const audioSession = { type: 'auto' };
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => {
        if (audioSession.type === 'playback') throw new Error('AudioSession category is not compatible with audio capture.');
        return { getTracks: () => [{ stop }] };
    });
    vi.stubGlobal('navigator', { audioSession, mediaDevices: { getUserMedia } });
    class Context {
        state = 'running';
        destination = {};
        close = vi.fn(async () => {});
        createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
        createScriptProcessor = () => ({ connect() {}, disconnect() {}, onaudioprocess: null });
        createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
    }
    vi.stubGlobal('AudioContext', Context);
    let source!: DictationAudioSource;
    function Probe() { source = useDictationAudioSource({ onPcmSegment() {} }); return null; }
    const root = createRoot(document.createElement('div'));
    try {
        await act(async () => root.render(<Probe />));
        prepareSpeechPlayback();
        await act(async () => source.start());
        expect(getUserMedia).toHaveBeenCalledOnce();
        await act(async () => source.stop());
        expect(stop).toHaveBeenCalledOnce();
    } finally {
        await act(async () => root.unmount());
    }
});
