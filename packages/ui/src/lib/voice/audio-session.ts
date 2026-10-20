const captureListeners = new Set<() => void>();

export function subscribeSpeechCapture(listener: () => void): () => void {
    captureListeners.add(listener);
    return () => { captureListeners.delete(listener); };
}

/** Stop owned playback before asking WebKit for microphone access. */
export function prepareSpeechCapture(): void {
    for (const listener of captureListeners) listener();
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    if (typeof navigator === 'undefined') return;
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (!session) return;
    try {
        session.type = 'play-and-record';
    } catch {
        // Engines without a writable Audio Session API choose their own category.
    }
}

/** WebKit: media playback ignores the iOS Ring/Silent switch (iOS 17+). */
export function prepareSpeechPlayback(): void {
    if (typeof navigator === 'undefined') return;
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (!session) return;
    try {
        if (session.type !== 'playback') session.type = 'playback';
    } catch {
        // Older engines may expose the API without accepting an explicit type.
    }
}
