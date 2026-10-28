import { expect, it } from 'vitest';
import { NativeGuiError, requestNativeGui } from './native-errors';
import type { NativeGuiBridge } from './native-types';

const bridge = (value: unknown): NativeGuiBridge => ({ request: async () => JSON.parse(JSON.stringify(value)), subscribe: () => () => {} });
it('preserves machine-readable refusal codes across the serialized IPC envelope', async () => {
  const error = await requestNativeGui(bridge({ ok: false, error: { code: 'GUI_PLUGIN_UNTRUSTED_SOURCE', message: 'private upstream detail' } }), 'acquire', {}).catch((cause) => cause);
  expect(error).toBeInstanceOf(NativeGuiError);
  if (!(error instanceof NativeGuiError)) throw new Error('Expected a native GUI refusal');
  expect(error.code).toBe('GUI_PLUGIN_UNTRUSTED_SOURCE');
  expect(error.message).not.toContain('private upstream detail');
  expect(await requestNativeGui(bridge({ ok: true, value: { answer: 1 } }), 'call', {})).toEqual({ answer: 1 });
});
it('classifies transport failures and malformed responses without leaking raw errors', async () => {
  await expect(requestNativeGui({ request: async () => { throw new Error('secret'); }, subscribe: () => () => {} }, 'call', {}))
    .rejects.toMatchObject({ code: 'GUI_PLUGIN_UNAVAILABLE' });
  await expect(requestNativeGui(bridge(null), 'call', {})).rejects.toMatchObject({ code: 'GUI_PLUGIN_INVALID_OUTPUT' });
  await expect(requestNativeGui(bridge({ ok: false, error: { code: 'unrecognized' } }), 'call', {})).rejects.toMatchObject({ code: 'GUI_PLUGIN_FAILED' });
});
