import { expect, it, vi } from 'vitest';
import { Schema } from 'effect';
import { Ipc } from '@opencode/plugin/gui';
import { NativeGuiSession } from './native';
import type { NativeGuiEvent, NativeGuiBridge } from './native-types';

const token = Ipc.define({ id: 'test.api', state: Schema.Number, events: { changed: Schema.Number }, methods: {
  add: { input: Schema.Number, output: Schema.Number }, ping: { output: Schema.Number },
} });
function fixture() {
  let receive: (event: NativeGuiEvent) => void = () => {};
  const stop = vi.fn();
  const request = vi.fn<NativeGuiBridge['request']>(async (action) => ({ ok: true, value: action === 'watch'
    ? { type: 'state', ipc: token.id, sequence: 1, available: true, state: 1 } : 5 }));
  const session = new NativeGuiSession({ request, subscribe: (fn) => { receive = fn; return stop; } }, {
    lease: 'lease', os: 'macos', app: { version: '1', packaged: false }, bundle: { revision: 'r1', code: '', options: {} },
  });
  return { session, request, stop, emit: (event: NativeGuiEvent) => receive(event),
    receive: (event: Omit<Extract<NativeGuiEvent, { type: 'state' }>, 'lease'>) => receive({ ...event, lease: 'lease' }) };
}

it('encodes calls, decodes replies, shares token clients and preserves newer pushed state over snapshots', async () => {
  const f = fixture();
  try {
    const api = f.session.token(token);
    f.receive({ type: 'state', ipc: token.id, sequence: 3, available: true, state: 3 });
    await vi.waitFor(() => expect(api.live().status).toBe('active'));
    expect(api.value.state()).toBe(3);
    expect(f.session.token(token)).toBe(api);
    expect(await api.value.add(4)).toBe(5);
    expect(f.request).toHaveBeenLastCalledWith('call', expect.objectContaining({ lease: 'lease', ipc: token.id, method: 'add', input: 4 }));
    await expect(api.value.add('wrong' as unknown as number)).rejects.toThrow();
    f.request.mockResolvedValueOnce({ ok: true, value: 'bad' });
    await expect(api.value.ping()).rejects.toThrow();
    f.receive({ type: 'state', ipc: token.id, sequence: 4, available: false });
    expect(api.value.state()).toBeUndefined();
    expect(api.live()).toEqual({ status: 'inactive', reason: 'disabled' });
  } finally { f.session.dispose(); }
  expect(f.stop).toHaveBeenCalledOnce();
});

it('uses the first argument as cancellation options for no-input methods and releases once', async () => {
  const f = fixture();
  const api = f.session.token(token);
  await vi.waitFor(() => expect(api.live().status).toBe('active'));
  f.request.mockImplementationOnce(() => new Promise(() => {}));
  const controller = new AbortController();
  const call = api.value.ping({ signal: controller.signal });
  controller.abort();
  await expect(call).rejects.toThrow('aborted');
  expect(f.request).toHaveBeenCalledWith('cancel', expect.objectContaining({ lease: 'lease' }));
  f.session.dispose(); f.session.dispose();
  expect(f.request.mock.calls.filter(([action]) => action === 'release')).toHaveLength(1);
  await expect(api.value.add(1)).rejects.toThrow();
});

it('decodes events only for its lease and revokes live clients when main withdraws the revision', async () => {
  const f = fixture(); const api = f.session.token(token);
  await vi.waitFor(() => expect(api.live().status).toBe('active'));
  const listener = vi.fn();
  const stop = api.value.on('changed', listener);
  const event = { type: 'event' as const, ipc: token.id, sequence: 2, name: 'changed', data: 7 };
  f.emit({ ...event, lease: 'foreign' });
  expect(listener).not.toHaveBeenCalled();
  f.emit({ ...event, lease: 'lease' });
  expect(listener).toHaveBeenCalledExactlyOnceWith(7);
  stop(); f.emit({ ...event, sequence: 3, lease: 'lease' });
  expect(listener).toHaveBeenCalledOnce();
  f.emit({ type: 'ended', ipc: '', sequence: 4, lease: 'lease' });
  expect(f.session.active).toBe(false);
  expect(api.live()).toEqual({ status: 'inactive', reason: 'disabled' });
  await expect(api.value.add(1)).rejects.toThrow();
});
