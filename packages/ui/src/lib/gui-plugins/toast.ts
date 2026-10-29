import type { Toasts, ToastOptions, ToastHandle } from '@opencode/plugin/gui';
import type { toast } from 'sonner';
import { NativeGuiError } from './native-errors';

/** A window-local SDK API. Its lifetime belongs to the plugin, not a panel owner. */
export function createGuiToasts(owner: AbortSignal, sink?: typeof toast): Toasts {
    const entries = new Map<string, { id: string | number; handle: ToastHandle; timer?: ReturnType<typeof setTimeout> }>();
    const stopped = Object.freeze({ dismiss() {} });
    owner.addEventListener('abort', () => {
        for (const entry of [...entries.values()]) entry.handle.dismiss();
    }, { once: true });
    return Object.freeze({
        show(input: ToastOptions): ToastHandle {
            if (owner.aborted) return stopped;
            if (!sink) throw new NativeGuiError('GUI_PLUGIN_UNSUPPORTED', 'GUI toast is unavailable');
            if (!input || typeof input !== 'object') throw new NativeGuiError('GUI_PLUGIN_INVALID_INPUT', 'Expected toast options');
            const { title, description, variant = 'default', duration = 5000, persistent = false, icon, actions } = input;
            if (typeof title !== 'string' || (description !== undefined && typeof description !== 'string') ||
                !['default', 'success', 'error', 'loading'].includes(variant) || typeof persistent !== 'boolean' ||
                typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
                throw new NativeGuiError('GUI_PLUGIN_INVALID_INPUT', 'Invalid toast options');
            }
            if (icon !== undefined || actions !== undefined) throw new NativeGuiError('GUI_PLUGIN_UNSUPPORTED', 'GUI toast icon/actions are unsupported');
            if (owner.aborted) return stopped;
            // Never spread plugin input into Sonner: only plain text and the validated options cross this boundary.
            const key = JSON.stringify([title, description ?? null, variant, duration, persistent]);
            const previous = entries.get(key);
            const forget = () => {
                const entry = entries.get(key);
                if (!entry || entry.id !== id) return;
                clearTimeout(entry.timer);
                entries.delete(key);
            };
            const show = variant === 'default' ? sink : sink[variant];
            const id = show(title, {
                id: previous?.id, description, duration: persistent ? Infinity : duration,
                onDismiss: forget, onAutoClose: forget,
            });
            const handle = previous?.handle ?? Object.freeze({ dismiss() { forget(); sink.dismiss(id); } });
            clearTimeout(previous?.timer);
            // Sonner intentionally does not auto-close its loading variant.
            const timer = variant === 'loading' && !persistent ? setTimeout(() => handle.dismiss(), duration) : undefined;
            entries.set(key, { id, handle, timer });
            return handle;
        },
    });
}
