import messages from './native-errors.json';
import type { NativeGuiBridge } from './native-types';

export type NativeGuiErrorCode = keyof typeof messages;

export class NativeGuiError extends Error {
  readonly name = 'GuiPluginError';
  constructor(readonly code: NativeGuiErrorCode, detail?: string) { super(`${code}: ${detail ?? messages[code]}`); }
}

/** Decode in the renderer: Electron/contextBridge do not preserve custom Error properties. */
export async function requestNativeGui(bridge: NativeGuiBridge, action: string, input: Record<string, unknown>): Promise<unknown> {
  let result: unknown;
  try { result = await bridge.request(action, input); }
  catch { throw new NativeGuiError('GUI_PLUGIN_UNAVAILABLE'); }
  if (!result || typeof result !== 'object' || !('ok' in result)) throw new NativeGuiError('GUI_PLUGIN_INVALID_OUTPUT');
  if (result.ok === true) return 'value' in result ? result.value : undefined;
  if ('error' in result && result.error && typeof result.error === 'object' && 'code' in result.error
    && typeof result.error.code === 'string' && Object.hasOwn(messages, result.error.code)) {
    throw new NativeGuiError(result.error.code as NativeGuiErrorCode);
  }
  throw new NativeGuiError('GUI_PLUGIN_FAILED');
}
