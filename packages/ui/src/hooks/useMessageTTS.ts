/**
 * useMessageTTS Hook
 * 
 * Hook for playing TTS on individual messages.
 * Uses the configured voice provider (browser, OpenAI, or macOS Say).
 */

import { useEffect, useRef, useState } from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import { useConfigStore } from '@/stores/useConfigStore';
import { useServerTTS } from './useServerTTS';
import { useSayTTS } from './useSayTTS';
import { useLocalTTS } from './useLocalTTS';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { sanitizeForTTS } from '@/lib/voice/summarize';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeSpeechCapture } from '@/lib/voice/audio-session';

// Below this length the reply is comfortable to listen to as-is; summarizing
// would only add latency.
const TTS_SUMMARIZE_MIN_CHARS = 600;

let stopActiveMessageSpeech: (() => void) | null = null;

const SUMMARIZE_SYSTEM_PROMPT = 'Summarize the assistant reply for text-to-speech listening. Reply with 2-4 sentences of plain spoken prose in the same language as the reply. No markdown, no lists, no code — mention code changes briefly in words instead.';

async function summarizeForSpeech(
    text: string,
    preferred: { providerID?: string; modelID?: string },
): Promise<string | null> {
    try {
        const response = await runtimeFetch('/api/small-model/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: text,
                system: SUMMARIZE_SYSTEM_PROMPT,
                ...(preferred.providerID ? { preferredProviderID: preferred.providerID } : {}),
                ...(preferred.modelID ? { preferredModelID: preferred.modelID } : {}),
            }),
        });
        if (!response.ok) return null;
        const payload = await response.json().catch(() => null) as { text?: unknown } | null;
        return typeof payload?.text === 'string' && payload.text.trim() ? payload.text.trim() : null;
    } catch {
        return null;
    }
}

export interface UseMessageTTSReturn {
    /** Whether TTS is currently playing for this message */
    isPlaying: boolean;
    /** Play the message text */
    play: (text: string, onSettled?: (error?: Error) => void) => Promise<void>;
    unlock: () => Promise<void>;
    /** Stop playback */
    stop: () => void;
}

export function useMessageTTS(options: { enabled?: boolean } = {}): UseMessageTTSReturn {
    const [isPlaying, setIsPlaying] = useState(false);
    const generation = useRef(0);
    
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const speechRate = useConfigStore((state) => state.speechRate);
    const speechPitch = useConfigStore((state) => state.speechPitch);
    const speechVolume = useConfigStore((state) => state.speechVolume);
    const browserVoice = useConfigStore((state) => state.browserVoice);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const ttsInputMode = useConfigStore((state) => state.ttsInputMode);

    const isServerProvider = voiceProvider === 'openai' || voiceProvider === 'openai-compatible' || voiceProvider === 'volcengine';
    const shouldCheckSayAvailability = (options.enabled ?? showMessageTTSButtons) && voiceProvider === 'say';

    const { speak: speakServerTTS, stop: stopServerTTS, unlockAudio } = useServerTTS({ enabled: false });
    const { speak: speakSayTTS, stop: stopSayTTS, unlockAudio: unlockSayAudio, isAvailable: isSayTTSAvailable } = useSayTTS({
        enabled: shouldCheckSayAvailability,
    });
    const { speak: speakLocalTTS, stop: stopLocalTTS, unlockAudio: unlockLocalAudio } = useLocalTTS();
    
    const stop = useEvent(() => {
        generation.current += 1;
        setIsPlaying(false);
        stopServerTTS();
        stopSayTTS();
        stopLocalTTS();
        if (stopActiveMessageSpeech === stop) {
            stopActiveMessageSpeech = null;
            browserVoiceService.cancelSpeech();
        }
    });
    useEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || event.isComposing || !isPlaying) return;
        event.preventDefault();
        event.stopPropagation();
        stop();
    }, () => isPlaying ? window : null, { capture: true });
    useEffect(() => subscribeSpeechCapture(stop), [stop]);
    const unlock = useEvent(async () => {
        const providerUnlock = voiceProvider === 'local' ? unlockLocalAudio
            : voiceProvider === 'say' ? unlockSayAudio : isServerProvider ? unlockAudio : null;
        await Promise.all([providerUnlock?.(), browserVoiceService.resumeAudioContext()]);
    });
    useEffect(() => () => {
        if (stopActiveMessageSpeech === stop) stop();
        else generation.current += 1;
    }, [stop]);
    
    const play = useEvent(async (text: string, onSettled?: (error?: Error) => void) => {
        if (!text.trim()) { onSettled?.(); return; }
        
        // Stop any existing playback
        stopActiveMessageSpeech?.();
        stop();
        stopActiveMessageSpeech = stop;
        const request = generation.current;
        let settled = false;
        const finish = (error?: Error) => {
            if (request !== generation.current || settled) return;
            settled = true;
            if (stopActiveMessageSpeech === stop) stopActiveMessageSpeech = null;
            setIsPlaying(false);
            onSettled?.(error);
        };
        const fail = (error: string) => finish(new Error(error));
        
        setIsPlaying(true);
        
        try {
            // Summarized mode: replace long replies with a short spoken-prose
            // summary from the small model; fall back to the sanitized
            // original when summarization is unavailable.
            let sourceText = text;
            if (ttsInputMode === 'summarized' && text.length >= TTS_SUMMARIZE_MIN_CHARS) {
                const { currentProviderId, currentModelId } = useConfigStore.getState();
                const summary = await summarizeForSpeech(text, {
                    providerID: currentProviderId || undefined,
                    modelID: currentModelId || undefined,
                });
                if (summary) {
                    sourceText = summary;
                }
            }

            if (request !== generation.current) return;
            const shouldUseRaw = ttsInputMode === 'raw' && isServerProvider;
            const sanitizedText = sanitizeForTTS(sourceText);
            const textToSpeak = shouldUseRaw ? sourceText : sanitizedText;
            if (!textToSpeak.trim()) { finish(); return; }
            
            if (isServerProvider) {
                await speakServerTTS(textToSpeak, {
                    onEnd: () => finish(),
                    onError: fail,
                });
            } else if (voiceProvider === 'local') {
                await speakLocalTTS(sanitizedText, {
                    onEnd: () => finish(),
                    onError: fail,
                });
            } else if (voiceProvider === 'say' && isSayTTSAvailable) {
                await speakSayTTS(sanitizedText, {
                    onEnd: () => finish(),
                    onError: fail,
                });
            } else {
                // Browser TTS
                await browserVoiceService.waitForVoices();
                await browserVoiceService.resumeAudioContext();
                if (request !== generation.current) return;
                await browserVoiceService.speakText(
                    sanitizedText,
                    navigator.language || 'en-US',
                    () => finish(),
                    {
                        rate: speechRate,
                        pitch: speechPitch,
                        volume: speechVolume,
                        voiceName: browserVoice || undefined,
                    }
                );
            }
        } catch (err) {
            console.error('[useMessageTTS] Playback error:', err);
            finish(err instanceof Error ? err : new Error(String(err)));
        }
    });
    
    return {
        isPlaying,
        play,
        stop,
        unlock,
    };
}
