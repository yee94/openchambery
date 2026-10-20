/**
 * Streaming dictation state machine.
 *
 * Status flow: idle -> recording -> uploading -> idle | failed.
 * While recording, mic PCM chunks stream to the server, which sends back live
 * partial transcripts. Confirm finalizes and resolves the full text; failed
 * dictations retain their audio segments so retry can replay them.
 */

import { useEffect, useRef, useState } from 'react';
import { useEvent } from '@reactuses/core';
import { useI18n } from '@/lib/i18n';

import { dictationClient } from '@/lib/dictation/dictation-client';
import { DictationStreamSender } from '@/lib/dictation/dictation-stream-sender';
import { useDictationAudioSource } from '@/lib/dictation/use-dictation-audio-source';

export type DictationStatus = 'idle' | 'recording' | 'uploading' | 'failed';

export interface UseDictationOptions {
    onTranscript?: (text: string) => void;
    onPartialTranscript?: (text: string) => void;
    onError?: (error: Error) => void;
    canStart?: () => boolean;
}

export interface UseDictationResult {
    status: DictationStatus;
    isRecording: boolean;
    isStarting: boolean;
    isProcessing: boolean;
    partialTranscript: string;
    volume: number;
    duration: number;
    error: string | null;
    errorReason: string | null;
    startDictation: () => Promise<void>;
    confirmDictation: () => Promise<string | null>;
    cancelDictation: () => Promise<void>;
    retryFailedDictation: () => Promise<string | null>;
    acceptPartialTranscript: () => string | null;
    discardFailedDictation: () => void;
}

const DURATION_TICK_MS = 1000;

const toError = (value: unknown): Error =>
    value instanceof Error ? value : new Error(String(value));

export function useDictation(options: UseDictationOptions = {}): UseDictationResult {
    const { t } = useI18n();
    const { onTranscript, onError, canStart } = options;

    const [status, setStatus] = useState<DictationStatus>('idle');
    const [isStarting, setIsStarting] = useState(false);
    const [partialTranscript, setPartialTranscript] = useState('');
    const [duration, setDuration] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [errorReason, setErrorReason] = useState<string | null>(null);

    const statusRef = useRef(status);
    useEffect(() => {
        statusRef.current = status;
    }, [status]);

    const latestPartialRef = useRef('');
    const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const actionGateRef = useRef({ starting: false, confirming: false, cancelling: false });
    const operationGenerationRef = useRef(0);

    const onTranscriptRef = useRef(onTranscript);
    const onErrorRef = useRef(onError);
    useEffect(() => {
        onTranscriptRef.current = onTranscript;
        onErrorRef.current = onError;
    }, [onTranscript, onError]);

    const senderRef = useRef<DictationStreamSender | null>(null);
    if (!senderRef.current) {
        senderRef.current = new DictationStreamSender({
            client: dictationClient,
        });
    }

    const stopDurationTracking = useEvent(() => {
        if (durationIntervalRef.current) {
            clearInterval(durationIntervalRef.current);
            durationIntervalRef.current = null;
        }
    });

    const startDurationTracking = useEvent(() => {
        if (durationIntervalRef.current) {
            return;
        }
        durationIntervalRef.current = setInterval(() => {
            setDuration((prev) => prev + 1);
        }, DURATION_TICK_MS);
    });

    const reportError = useEvent((err: unknown) => {
        const normalized = toError(err);
        const displayError = normalized.name === 'NotFoundError' || normalized.name === 'DevicesNotFoundError'
            ? new Error(t('chat.dictation.error.microphoneNotFound'), { cause: normalized })
            : normalized;
        setError(displayError.message);
        const reason = (normalized as Error & { reasonCode?: string }).reasonCode;
        setErrorReason(typeof reason === 'string' ? reason : null);
        onErrorRef.current?.(displayError);
    });

    const clearError = useEvent(() => {
        setError(null);
        setErrorReason(null);
    });

    const clearStreamingState = useEvent(() => {
        senderRef.current?.clearAll();
        latestPartialRef.current = '';
        setPartialTranscript('');
    });

    // Live partial transcripts for the active dictation.
    const publishPartial = useEvent((text: string) => options.onPartialTranscript?.(text));
    useEffect(() => {
        return dictationClient.onPartial((dictationId, text) => {
            const activeDictationId = senderRef.current?.getDictationId();
            if (!activeDictationId || dictationId !== activeDictationId) {
                return;
            }
            latestPartialRef.current = text;
            setPartialTranscript(text);
            publishPartial(text);
        });
    }, [publishPartial]);

    // Restart the stream (replaying buffered segments) after a reconnect.
    useEffect(() => {
        return dictationClient.subscribeConnectionStatus((connected) => {
            if (!connected) {
                if (statusRef.current === 'recording') senderRef.current?.resetStreamForReplay();
                return;
            }
            if (statusRef.current !== 'recording') {
                return;
            }
            if (senderRef.current?.getDictationId()) return;
            const generation = operationGenerationRef.current;
            void senderRef.current?.restartStream().catch((err) => {
                if (operationGenerationRef.current === generation) reportError(err);
            });
        });
    }, [reportError]);

    const audio = useDictationAudioSource({
        onPcmSegment: (audioData) => {
            if (statusRef.current === 'recording') senderRef.current?.enqueueSegment(audioData);
        },
        onError: (err) => {
            onErrorRef.current?.(err);
        },
    });
    const audioStopRef = useRef(audio.stop);
    useEffect(() => {
        audioStopRef.current = audio.stop;
    }, [audio.stop]);

    const handleSuccess = useEvent(
        (text: string): string | null => {
            setDuration(0);
            setStatus('idle');
            statusRef.current = 'idle';
            const transcriptText = text.trim().length > 0 ? text.trim() : latestPartialRef.current.trim();
            clearStreamingState();
            if (!transcriptText) {
                return null;
            }
            onTranscriptRef.current?.(transcriptText);
            return transcriptText;
        },
    );

    const handleFailure = useEvent(
        (failure: unknown) => {
            if (senderRef.current?.hasSegments()) {
                setStatus('failed');
                statusRef.current = 'failed';
            } else {
                setStatus('idle');
                statusRef.current = 'idle';
            }
            reportError(failure);
        },
    );

    const startDictation = useEvent(async () => {
        const gate = actionGateRef.current;
        if (gate.starting || gate.confirming || gate.cancelling) {
            return;
        }
        if (statusRef.current !== 'idle') {
            return;
        }
        if (canStart && !canStart()) {
            return;
        }

        gate.starting = true;
        setIsStarting(true);
        const generation = ++operationGenerationRef.current;
        clearError();
        setPartialTranscript('');
        setDuration(0);
        setStatus('recording');
        statusRef.current = 'recording';
        clearStreamingState();

        try {
            await audio.start();
            if (operationGenerationRef.current !== generation || statusRef.current !== 'recording') return;
            setIsStarting(false);
            startDurationTracking();
            // Open the stream eagerly so partials start flowing immediately.
            await senderRef.current?.restartStream().catch((err) => {
                // Non-fatal: segments buffer locally and finish() retries the
                // start, but surface the reason (e.g. model downloading) so
                // the overlay can show it.
                if (operationGenerationRef.current === generation) reportError(err);
            });
        } catch (err) {
            if (operationGenerationRef.current !== generation) return;
            await audio.stop().catch(() => undefined);
            stopDurationTracking();
            setStatus('idle');
            statusRef.current = 'idle';
            reportError(err);
        } finally {
            if (operationGenerationRef.current === generation) setIsStarting(false);
            gate.starting = false;
        }
    });

    const cancelDictation = useEvent(async () => {
        const gate = actionGateRef.current;
        if (gate.cancelling) {
            return;
        }
        if (statusRef.current !== 'recording' && statusRef.current !== 'uploading') {
            return;
        }
        gate.cancelling = true;
        setIsStarting(false);
        operationGenerationRef.current += 1;
        stopDurationTracking();
        setDuration(0);
        clearError();

        // Optimistic: dismiss the overlay immediately. Tearing down the audio
        // graph (AudioContext.close) can take up to ~1s on mobile WebViews and
        // must not delay the visible response to Cancel.
        setStatus('idle');
        statusRef.current = 'idle';
        try {
            senderRef.current?.cancel();
        } catch {
            // no-op
        }
        clearStreamingState();

        try {
            await audio.stop();
        } catch {
            // Cancelled anyway; mic teardown failures are not user-actionable.
        } finally {
            gate.cancelling = false;
        }
    });

    const confirmDictation = useEvent(async (): Promise<string | null> => {
        const gate = actionGateRef.current;
        if (gate.confirming) {
            return null;
        }
        if (statusRef.current !== 'recording') {
            return null;
        }

        gate.confirming = true;
        setIsStarting(false);
        const generation = ++operationGenerationRef.current;
        clearError();
        stopDurationTracking();

        try {
            await audio.stop();
            if (operationGenerationRef.current !== generation) return null;
            setStatus('uploading');
            statusRef.current = 'uploading';

            const finalSeq = senderRef.current?.getFinalSeq() ?? -1;
            if (finalSeq < 0) {
                senderRef.current?.cancel();
                return handleSuccess('');
            }

            const result = await senderRef.current!.finish(finalSeq);
            if (operationGenerationRef.current !== generation) return null;
            return handleSuccess(result.text);
        } catch (err) {
            if (operationGenerationRef.current !== generation) return null;
            handleFailure(err);
            return null;
        } finally {
            gate.confirming = false;
        }
    });

    const retryFailedDictation = useEvent(async (): Promise<string | null> => {
        if (statusRef.current !== 'failed' || !senderRef.current?.hasSegments()) {
            return null;
        }
        clearError();
        const generation = ++operationGenerationRef.current;
        setStatus('uploading');
        statusRef.current = 'uploading';

        try {
            senderRef.current.resetStreamForReplay();
            const finalSeq = senderRef.current.getFinalSeq();
            const result = await senderRef.current.finish(finalSeq);
            if (operationGenerationRef.current !== generation) return null;
            return handleSuccess(result.text);
        } catch (err) {
            if (operationGenerationRef.current !== generation) return null;
            handleFailure(err);
            return null;
        }
    });

    /**
     * Failed dictations still hold the last streamed partial transcript.
     * Accept it as-is instead of retrying the full transcription.
     */
    const acceptPartialTranscript = useEvent((): string | null => {
        if (statusRef.current !== 'failed') {
            return null;
        }
        const text = latestPartialRef.current.trim();
        setDuration(0);
        setStatus('idle');
        statusRef.current = 'idle';
        clearError();
        try {
            senderRef.current?.cancel();
        } catch {
            // no-op
        }
        clearStreamingState();
        if (!text) {
            return null;
        }
        onTranscriptRef.current?.(text);
        return text;
    });

    const discardFailedDictation = useEvent(() => {
        setDuration(0);
        setStatus('idle');
        statusRef.current = 'idle';
        clearError();
        clearStreamingState();
    });

    // While recording without an open stream (e.g. the model is still
    // downloading), retry the stream start so live partials kick in as soon
    // as the provider becomes ready. Buffered segments replay on success.
    useEffect(() => {
        if (status !== 'recording' || errorReason !== 'model_download_in_progress') {
            return;
        }
        const interval = setInterval(() => {
            if (statusRef.current !== 'recording' || senderRef.current?.getDictationId()) {
                return;
            }
            senderRef.current?.restartStream().then(() => {
                clearError();
            }).catch((err) => {
                reportError(err);
            });
        }, 3000);
        return () => clearInterval(interval);
    }, [status, errorReason, clearError, reportError]);

    useEffect(() => {
        return () => {
            operationGenerationRef.current += 1;
            stopDurationTracking();
            void audioStopRef.current().catch(() => undefined);
            senderRef.current?.cancel();
        };
    }, [stopDurationTracking]);

    return {
        status,
        isRecording: status === 'recording',
        isStarting,
        isProcessing: status === 'uploading',
        partialTranscript,
        volume: audio.volume,
        duration,
        error,
        errorReason,
        startDictation,
        confirmDictation,
        cancelDictation,
        retryFailedDictation,
        acceptPartialTranscript,
        discardFailedDictation,
    };
}
