import { Capacitor, registerPlugin } from '@capacitor/core';
import { isCapacitorApp } from '@/lib/platform';
import { NativeGuiError } from './native-errors';

const media = registerPlugin<{
    saveFile(input: { dataBase64: string; mimeType: string; filename: string }): Promise<{ cancelled?: boolean }>;
}>('YuriMedia');

/** SDK system.save writes client-owned bytes, never a connected Host path. */
export async function saveGuiFile(file: { name: string; content: string }): Promise<boolean> {
    const mimeType = /\.html?$/i.test(file.name) ? 'text/html' : 'text/plain';
    const blob = new Blob([file.content], { type: mimeType });
    if (isCapacitorApp()) {
        if (!Capacitor.isPluginAvailable('YuriMedia')) {
            throw new NativeGuiError('GUI_PLUGIN_UNSUPPORTED', 'Native file saving is unavailable');
        }
        if (blob.size > 32 * 1024 * 1024) {
            throw new NativeGuiError('GUI_PLUGIN_INVALID_INPUT', 'File exceeds maximum size');
        }
        const dataBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                if (typeof reader.result !== 'string') { reject(new Error('Failed to encode file')); return; }
                resolve(reader.result.slice(reader.result.indexOf(',') + 1));
            };
            reader.onerror = () => reject(reader.error ?? new Error('Failed to encode file'));
            reader.readAsDataURL(blob);
        });
        const result = await media.saveFile({ dataBase64, mimeType, filename: file.name });
        return !result.cancelled;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    try {
        link.href = url;
        link.download = file.name;
        document.body.append(link);
        link.click();
        return true;
    } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
}
