import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireScreenAwake } from './screen-awake';

const native = vi.hoisted(() => ({ enabled: false, setEnabled: vi.fn() }));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => native.enabled, isPluginAvailable: () => native.enabled },
    registerPlugin: () => ({ setEnabled: native.setEnabled }),
}));
beforeEach(() => { vi.clearAllMocks(); native.enabled = false; native.setEnabled.mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllGlobals());

it('requests a screen wake lock and releases only once', async () => {
    const lock = { released: false, release: vi.fn(async () => { lock.released = true; }) };
    const request = vi.fn(async () => lock);
    vi.stubGlobal('navigator', { wakeLock: { request } });
    const release = await acquireScreenAwake(); await release(); await release();
    expect(request).toHaveBeenCalledWith('screen'); expect(lock.release).toHaveBeenCalledTimes(1);
});

it('a late old native lease release cannot turn off a newer lease', async () => {
    native.enabled = true;
    const first = await acquireScreenAwake(); const second = await acquireScreenAwake();
    await first();
    expect(native.setEnabled).not.toHaveBeenCalledWith({ enabled: false });
    await second();
    expect(native.setEnabled).toHaveBeenLastCalledWith({ enabled: false });
});

it('reports unsupported browsers rather than claiming to keep the screen awake', async () => {
    vi.stubGlobal('navigator', {});
    await expect(acquireScreenAwake()).rejects.toThrow('unavailable');
});
