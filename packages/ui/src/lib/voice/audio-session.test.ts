import { afterEach, expect, it, vi } from 'vitest';
import { prepareSpeechCapture, prepareSpeechPlayback, subscribeSpeechCapture } from './audio-session';

afterEach(() => vi.unstubAllGlobals());

it('requests the media category and reapplies it after the browser changes it', () => {
    const audioSession = { type: 'auto' };
    vi.stubGlobal('navigator', { audioSession });
    prepareSpeechPlayback();
    expect(audioSession.type).toBe('playback');
    audioSession.type = 'ambient';
    prepareSpeechPlayback();
    expect(audioSession.type).toBe('playback');
});

it('supports browsers without the API or with an unsupported setter', () => {
    vi.stubGlobal('navigator', {});
    expect(prepareSpeechPlayback).not.toThrow();
    vi.stubGlobal('navigator', { audioSession: { set type(_value: string) { throw new Error('Unsupported'); } } });
    expect(prepareSpeechPlayback).not.toThrow();
    expect(prepareSpeechCapture).not.toThrow();
});

it('stops registered playback before switching to microphone capture and cleans up subscribers', () => {
    const audioSession = { type: 'playback' };
    vi.stubGlobal('navigator', { audioSession });
    const stop = vi.fn(() => expect(audioSession.type).toBe('playback'));
    const unsubscribe = subscribeSpeechCapture(stop);
    try {
        prepareSpeechCapture();
        expect(stop).toHaveBeenCalledOnce();
        expect(audioSession.type).toBe('play-and-record');
    } finally {
        unsubscribe();
    }
    prepareSpeechCapture();
    expect(stop).toHaveBeenCalledOnce();
    prepareSpeechPlayback();
    expect(audioSession.type).toBe('playback');
});
