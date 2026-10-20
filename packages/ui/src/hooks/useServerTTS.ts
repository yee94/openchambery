/**
 * useServerTTS Hook
 * 
 * React hook for server-side text-to-speech playback.
 * Fetches audio from the server and plays it, bypassing mobile Safari restrictions.
 * 
 * @example
 * ```typescript
 * const { speak, isPlaying, stop, isAvailable } = useServerTTS();
 * 
 * // Speak text
 * await speak('Hello, this is a test');
 * 
 * // Stop playback
 * stop();
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { playPcmStream } from '@/lib/voice/pcm-stream';
import { prepareSpeechPlayback } from '@/lib/voice/audio-session';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

interface ServerTTSStatusCache {
  available: boolean;
  checkedAt: number;
}

interface PlaybackSession {
  abort: AbortController;
}

interface UseServerTTSOptions {
  enabled?: boolean;
  availabilityMode?: 'auto' | 'openai' | 'openai-compatible';
}

const SERVER_TTS_STATUS_TTL_MS = 30000;
const serverTTSStatusCache = new Map<string, ServerTTSStatusCache>();
const serverTTSStatusRequests = new Map<string, Promise<boolean>>();

async function getServerTTSStatus(transportIdentity: string): Promise<boolean> {
  const now = Date.now();
  const cached = serverTTSStatusCache.get(transportIdentity);
  if (cached && now - cached.checkedAt < SERVER_TTS_STATUS_TTL_MS) {
    return cached.available;
  }

  const inFlight = serverTTSStatusRequests.get(transportIdentity);
  if (inFlight) {
    return inFlight;
  }

  const request = (async () => {
    try {
      const response = await runtimeFetch('/api/tts/status');
      if (!response.ok) {
        serverTTSStatusCache.set(transportIdentity, { available: false, checkedAt: Date.now() });
        return false;
      }

      const data = await response.json();
      const available = Boolean(data.available);
      serverTTSStatusCache.set(transportIdentity, { available, checkedAt: Date.now() });
      return available;
    } catch {
      serverTTSStatusCache.set(transportIdentity, { available: false, checkedAt: Date.now() });
      return false;
    } finally {
      serverTTSStatusRequests.delete(transportIdentity);
    }
  })();
  serverTTSStatusRequests.set(transportIdentity, request);

  return request;
}

export interface UseServerTTSReturn {
  /** Whether TTS is currently playing */
  isPlaying: boolean;
  /** Whether the server TTS service is available */
  isAvailable: boolean;
  /** Current error if any */
  error: string | null;
  /** Speak the given text */
  speak: (text: string, options?: SpeakOptions) => Promise<void>;
  /** Stop current playback */
  stop: () => void;
  /** Check if service is available */
  checkAvailability: () => Promise<boolean>;
  /** Unlock audio for mobile Safari - call this on user gesture before speaking */
  unlockAudio: () => Promise<void>;
}

interface SpeakOptions {
  provider?: 'volcengine' | 'openai' | 'openai-compatible';
  /** Voice to use (defaults to coral) */
  voice?: string;
  /** Model to use (defaults to gpt-4o-mini-tts) */
  model?: string;
  /** Speech speed (0.25 to 4.0, defaults to 1.0) */
  speed?: number;
  /** Speech pitch shift (0.5 to 2.0, mapped to cents; 1.0 = no shift) */
  pitch?: number;
  /** Playback volume (0 to 1, defaults to 1.0) */
  volume?: number;
  /** Optional instructions for the voice */
  instructions?: string;
  /** Summarize long text before speaking (defaults to true) */
  summarize?: boolean;
  /** Provider ID for summarization model */
  providerId?: string;
  /** Model ID for summarization */
  modelId?: string;
  /** Character threshold for summarization (defaults to 200) */
  threshold?: number;
  /** Custom base URL for OpenAI-compatible server */
  baseURL?: string;
  /** Callback when playback starts */
  onStart?: () => void;
  /** Callback when playback ends */
  onEnd?: () => void;
  /** Callback on error */
  onError?: (error: string) => void;
}

// Shared AudioContext for Web Audio API playback (better iOS support)
let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  prepareSpeechPlayback();
  if (!sharedAudioContext) {
    sharedAudioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  return sharedAudioContext;
}

export function useServerTTS(options: UseServerTTSOptions = {}): UseServerTTSReturn {
  const enabled = options.enabled ?? true;
  const availabilityMode = options.availabilityMode ?? 'auto';
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const sessionRef = useRef<PlaybackSession | null>(null);
  const availabilityGenerationRef = useRef(0);
  
  // Get current model and API settings from config store.
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const openaiApiKeyConfigured = useConfigStore((state) => state.openaiApiKeyConfigured);
  const openaiCompatibleUrl = useConfigStore((state) => state.openaiCompatibleUrl);

  // Check if server TTS is available
  const checkAvailability = useCallback(async (): Promise<boolean> => {
    const generation = ++availabilityGenerationRef.current;
    const transportIdentity = getRuntimeTransportIdentity();
    const applyAvailability = (available: boolean): boolean => {
      if (generation === availabilityGenerationRef.current && getRuntimeTransportIdentity() === transportIdentity) {
        setIsAvailable(available);
      }
      return available;
    };
    if (!enabled) {
      return applyAvailability(false);
    }

    const hasClientKey = openaiApiKeyConfigured;
    const hasCustomUrl = Boolean(openaiCompatibleUrl && openaiCompatibleUrl.trim().length > 0);
    if (availabilityMode === 'openai-compatible') {
      return applyAvailability(hasCustomUrl);
    }

    if (hasClientKey) {
      return applyAvailability(true);
    }

    if (availabilityMode === 'auto' && hasCustomUrl) {
      return applyAvailability(true);
    }

    try {
      return applyAvailability(await getServerTTSStatus(transportIdentity));
    } catch {
      return applyAvailability(false);
    }
  }, [availabilityMode, enabled, openaiApiKeyConfigured, openaiCompatibleUrl]);

  // Check availability on mount and when API key changes
  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  useEffect(() => subscribeRuntimeEndpointChanged(() => {
    void checkAvailability();
  }), [checkAvailability]);

  // Stop current playback
  const stop = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.abort.abort();

    // Stop Web Audio API source
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.onended = null;
        audioSourceRef.current.stop();
      } catch {
        // Already stopped
      }
      audioSourceRef.current = null;
    }
    
    setIsPlaying(false);
  }, []);

  // Pre-unlock audio for mobile Safari
  // This must be called within a user gesture context
  const unlockAudio = useCallback(async (): Promise<void> => {
    try {
      // Get or create AudioContext
      const ctx = getAudioContext();
      
      // Resume if suspended (required for iOS Safari)
      if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('[useServerTTS] AudioContext resumed');
      }
      
      // Play a tiny silent buffer to fully unlock
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      
      console.log('[useServerTTS] Audio unlocked for mobile playback');
    } catch (err) {
      console.error('[useServerTTS] Failed to unlock audio:', err);
    }
  }, []);

  // Speak text using server TTS
  const speak = useCallback(async (text: string, options?: SpeakOptions): Promise<void> => {
    // Stop any existing playback
    stop();

    if (!text.trim()) {
      setError('No text to speak');
      options?.onError?.('No text to speak');
      return;
    }

    setError(null);
    const session: PlaybackSession = { abort: new AbortController() };
    sessionRef.current = session;

    try {
      // Unlock audio context first (required for mobile Safari)
      // Must be done before any async operations to stay within user gesture context
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
        console.log('[useServerTTS] AudioContext resumed');
      }
      
      // Play a silent buffer to fully unlock audio on iOS
      const silentBuffer = ctx.createBuffer(1, 1, 22050);
      const silentSource = ctx.createBufferSource();
      silentSource.buffer = silentBuffer;
      silentSource.connect(ctx.destination);
      silentSource.start(0);

      const voice = options?.voice || 'nova';
      console.log('[useServerTTS] Speaking with voice:', voice, 'options:', options);

      // Fetch audio from server
      const volcengine = options?.provider === 'volcengine';
      const response = await runtimeFetch('/api/tts/speak', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text.trim(),
          voice,
          model: options?.model || undefined,
          speed: options?.speed || 0.9,
          instructions: options?.instructions,
          summarize: false,
          // Use provided provider/model, or fall back to current chat model
          providerId: options?.providerId || currentProviderId || undefined,
          modelId: options?.modelId || currentModelId || undefined,
          // Credentials are resolved by the Host for the selected speech provider.
          provider: options?.provider ?? (options?.baseURL ? 'openai-compatible' : 'openai'),
          // Send custom base URL for OpenAI-compatible servers
          baseURL: options?.baseURL || undefined,
          ...(volcengine ? {
            provider: 'volcengine',
            stream: true,
            apiKey: undefined,
            voice: undefined,
          } : {}),
        }),
        signal: session.abort.signal,
      });

      if (sessionRef.current !== session) {
        return;
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      if (volcengine && response.headers.get('content-type')?.includes('application/x-ndjson')) {
        await playPcmStream(response, ctx, {
          signal: session.abort.signal,
          pitch: options?.pitch ?? 1,
          volume: options?.volume ?? 1,
          onStart: () => {
            if (sessionRef.current !== session) return;
            setIsPlaying(true);
            options?.onStart?.();
          },
        });
        if (sessionRef.current === session) {
          sessionRef.current = null;
          setIsPlaying(false);
          options?.onEnd?.();
        }
        return;
      }

      // Get audio data from response
      const audioBlob = await response.blob();
      const arrayBuffer = await audioBlob.arrayBuffer();
      if (sessionRef.current !== session) {
        return;
      }
      
      // Decode audio data using the same context we unlocked earlier
      console.log('[useServerTTS] Decoding audio data...');
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      if (sessionRef.current !== session) {
        return;
      }
      
      // Create source node
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;

      // Apply pitch shift via detune (cents): 1200 cents = 1 octave
      const pitch = options?.pitch ?? 1.0;
      if (pitch !== 1.0) {
        source.detune.value = (pitch - 1.0) * 1200;
      }

      // Apply volume via GainNode
      const volume = options?.volume ?? 1.0;
      const gainNode = ctx.createGain();
      gainNode.gain.value = volume;

      source.connect(gainNode);
      gainNode.connect(ctx.destination);
      audioSourceRef.current = source;
      
      // Set up event handlers
      source.onended = () => {
        if (sessionRef.current !== session || audioSourceRef.current !== source) {
          return;
        }
        console.log('[useServerTTS] Audio playback ended');
        setIsPlaying(false);
        audioSourceRef.current = null;
        sessionRef.current = null;
        options?.onEnd?.();
      };
      
      // Start playback
      console.log('[useServerTTS] Starting audio playback via Web Audio API...');
      setIsPlaying(true);
      options?.onStart?.();
      if (sessionRef.current !== session || audioSourceRef.current !== source) {
        return;
      }
      source.start(0);
      
    } catch (err) {
      if ((err as Error).name === 'AbortError' || sessionRef.current !== session) {
        // Request was aborted, don't show error
        return;
      }
      
      const errorMsg = err instanceof Error ? err.message : 'Failed to speak';
      console.error('[useServerTTS] Error:', errorMsg);
      setError(errorMsg);
      options?.onError?.(errorMsg);
      setIsPlaying(false);
      if (audioSourceRef.current) {
        audioSourceRef.current.onended = null;
        audioSourceRef.current = null;
      }
      sessionRef.current = null;
    }
  }, [stop, currentProviderId, currentModelId]);

  // Cleanup on unmount
  useEffect(() => subscribeRuntimeEndpointChanged(stop), [stop]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    isPlaying,
    isAvailable,
    error,
    speak,
    stop,
    checkAvailability,
    unlockAudio,
  };
}
