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
