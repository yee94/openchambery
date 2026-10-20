import { Capacitor, registerPlugin } from '@capacitor/core';

const screenAwake = registerPlugin<{
    setEnabled(options: { enabled: boolean }): Promise<void>;
}>('OpenChamberScreenAwake');

let nativeOperations: Promise<void> = Promise.resolve();
let nativeLeases = 0;
function setNativeEnabled(enabled: boolean): Promise<void> {
    const next = nativeOperations.then(() => screenAwake.setEnabled({ enabled }));
    nativeOperations = next.catch(() => undefined);
    return next;
}

/** Release is idempotent; callers must release even if acquisition completes after unmount. */
export async function acquireScreenAwake(): Promise<() => Promise<void>> {
    if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('OpenChamberScreenAwake')) {
        nativeLeases += 1;
        try { await setNativeEnabled(true); }
        catch (error) { nativeLeases -= 1; throw error; }
        let released = false;
        return async () => {
            if (released) return;
            released = true;
            nativeLeases -= 1;
            if (nativeLeases === 0) await setNativeEnabled(false);
        };
    }
    if (!navigator.wakeLock) throw new Error('Screen wake lock unavailable');
    const lock = await navigator.wakeLock.request('screen');
    return async () => { if (!lock.released) await lock.release(); };
}
