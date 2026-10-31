import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import { GuiPluginHost } from './host';

const native = vi.hoisted(() => ({ available: true, saveFile: vi.fn(), isNative: true }));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isPluginAvailable: () => native.available },
    registerPlugin: () => ({ saveFile: native.saveFile }),
}));
vi.mock('@/lib/platform', () => ({ isCapacitorApp: () => native.isNative }));

let host: GuiPluginHost;
let client: QueryClient;
let save: (file: { name: string; content: string }) => Promise<boolean>;
beforeEach(() => {
    native.available = true;
    native.isNative = true;
    native.saveFile.mockReset().mockResolvedValue({ cancelled: false });
    client = new QueryClient();
    host = new GuiPluginHost({
        client: {} as OpenCodeClient, files: { readFile: vi.fn(), listDirectory: vi.fn(), search: vi.fn(), createDirectory: vi.fn() },
        queryClient: client, storage: localStorage, transport: 'save-test', locale: 'en', mode: 'dark', narrow: true,
    });
    Reflect.set(globalThis, '__captureGuiSave', (value: typeof save) => { save = value; });
    host.install('save-test', { revision: '1', options: {}, code: `
        const G = require('@opencode/plugin/gui');
        module.exports.default = G.Plugin.define({setup(ctx) { globalThis.__captureGuiSave(file => ctx.system.save(file)); }});
    ` });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export-test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
    host.dispose();
    client.clear();
    Reflect.deleteProperty(globalThis, '__captureGuiSave');
    vi.restoreAllMocks();
});

it('saves plugin HTML through the native picker and preserves UTF-8 bytes', async () => {
    const content = '<!doctype html><title>报告 🌍</title>';
    await expect(save({ name: '报告.html', content })).resolves.toBe(true);
    expect(native.saveFile).toHaveBeenCalledExactlyOnceWith({
        filename: '报告.html', mimeType: 'text/html', dataBase64: Buffer.from(content).toString('base64'),
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('does not report saved while the system picker is pending and returns false on cancel', async () => {
    let finish!: (result: { cancelled: boolean }) => void;
    native.saveFile.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    let settled = false;
    const pending = save({ name: 'report.html', content: 'report' }).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(native.saveFile).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finish({ cancelled: true });
    await expect(pending).resolves.toBe(false);
});

it('propagates native save failures instead of claiming a browser download succeeded', async () => {
    native.saveFile.mockRejectedValue(new Error('Save failed'));
    await expect(save({ name: 'report.html', content: 'report' })).rejects.toThrow('Save failed');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('rejects native shells without a save implementation', async () => {
    native.available = false;
    await expect(save({ name: 'report.html', content: 'report' })).rejects.toMatchObject({ code: 'GUI_PLUGIN_UNSUPPORTED' });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('retains browser downloads outside the native mobile shell', async () => {
    native.isNative = false;
    await expect(save({ name: 'report.html', content: 'report' })).resolves.toBe(true);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    expect(native.saveFile).not.toHaveBeenCalled();
});
