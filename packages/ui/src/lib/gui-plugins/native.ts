import { createSignal, getOwner, onCleanup, type Accessor } from 'solid-js';
import { liveAccessor } from '@opencode/plugin/gui/yuri-host';
import { Schema } from 'effect';
import type * as Gui from '@opencode/plugin/gui';
import type { NativeGuiActivation, NativeGuiBridge, NativeGuiEvent } from './native-types';
import { NativeGuiError, requestNativeGui } from './native-errors';

/** One native lease belongs to one installed window revision. */
export class NativeGuiSession {
  private controller = new AbortController();
  private tokens = new Map<string, { value: Gui.IpcClient<Gui.IpcSpec>; live: Accessor<Gui.Live<Gui.IpcClient<Gui.IpcSpec>>> }>();
  private listeners = new Set<(event: NativeGuiEvent) => void>();
  private stop: () => void;

  get active(): boolean { return !this.controller.signal.aborted; }

  constructor(private bridge: NativeGuiBridge, readonly activation: NativeGuiActivation) {
    this.stop = bridge.subscribe((event) => {
      if (event.lease !== activation.lease || this.controller.signal.aborted) return;
      if (event.type === 'ended') { this.dispose(); return; }
      for (const listener of this.listeners) listener(event);
    });
  }

  private request(action: string, input: Record<string, unknown> = {}) {
    if (!this.active) throw new NativeGuiError('GUI_PLUGIN_LEASE_EXPIRED');
    return requestNativeGui(this.bridge, action, { ...input, lease: this.activation.lease });
  }

  token<S extends Gui.IpcSpec>(token: Gui.Ipc<S>): { value: Gui.IpcClient<S>; live: Accessor<Gui.Live<Gui.IpcClient<S>>> } {
    const existing = this.tokens.get(token.id);
    if (existing) return existing as { value: Gui.IpcClient<S>; live: Accessor<Gui.Live<Gui.IpcClient<S>>> };
    const [state, setState] = createSignal<unknown>();
    const [live, setLive] = createSignal<Gui.Live<Gui.IpcClient<S>>>({ status: 'pending' });
    const events = new Map<string, Set<(data: unknown) => void>>();
    let sequence = 0;
    let generation = 0;
    const methods = Object.fromEntries(Object.entries(token.spec.methods).map(([name, spec]) => [name, async (...args: unknown[]) => {
      const options = (spec.input ? args[1] : args[0]) as Gui.IpcCallOptions | undefined;
      if (!this.active) throw new NativeGuiError('GUI_PLUGIN_LEASE_EXPIRED');
      const signal = AbortSignal.any([this.controller.signal, ...(options?.signal ? [options.signal] : [])]);
      const assertActive = () => { if (signal.aborted) throw new NativeGuiError('GUI_PLUGIN_ABORTED'); };
      assertActive();
      const input = spec.input ? await Schema.encodeUnknownPromise(spec.input)(args[0]).catch(() => { throw new NativeGuiError('GUI_PLUGIN_INVALID_INPUT'); }) : undefined;
      assertActive();
      const request = crypto.randomUUID();
      const pending = this.request('call', { ipc: token.id, method: name, input, request });
      const result = await new Promise<unknown>((resolve, reject) => {
        const abort = () => {
          void requestNativeGui(this.bridge, 'cancel', { lease: this.activation.lease, request }).catch(() => {});
          reject(new NativeGuiError('GUI_PLUGIN_ABORTED'));
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
      assertActive();
      const decoded = spec.output ? await Schema.decodeUnknownPromise(spec.output)(result).catch(() => { throw new NativeGuiError('GUI_PLUGIN_INVALID_OUTPUT'); }) : undefined;
      assertActive();
      return decoded;
    }]));
    const value = Object.assign(methods, {
      state,
      on: (name: string, listener: (data: unknown) => void) => {
        if (!token.spec.events?.[name]) throw new NativeGuiError('GUI_PLUGIN_INVALID_REQUEST');
        if (!this.active) throw new NativeGuiError('GUI_PLUGIN_LEASE_EXPIRED');
        const handlers = events.get(name) ?? new Set();
        events.set(name, handlers); handlers.add(listener);
        const stop = () => { handlers.delete(listener); };
        if (getOwner()) onCleanup(stop);
        return stop;
      },
    }) as Gui.IpcClient<S>;
    const apply = (event: NativeGuiEvent) => {
      if (event.ipc !== token.id || event.sequence <= sequence || this.controller.signal.aborted) return;
      // Event payloads do not supersede a state snapshot: only state messages do.
      if (event.type === 'event') {
        const schema = token.spec.events?.[event.name];
        if (schema) {
          const data = Schema.decodeUnknownSync(schema)(event.data);
          for (const listener of events.get(event.name) ?? []) listener(data);
        }
      } else if (event.type === 'state') {
        sequence = event.sequence;
        setState(() => event.available && token.spec.state ? Schema.decodeUnknownSync(token.spec.state)(event.state) : undefined);
        if (!event.available) setLive({ status: 'inactive', reason: 'disabled' });
        else if (live().status !== 'active') setLive({ status: 'active', value, generation: ++generation });
      }
    };
    const receive = (event: NativeGuiEvent) => {
      try { apply(event); }
      catch { setState(undefined); setLive({ status: 'inactive', reason: 'failed' }); }
    };
    this.listeners.add(receive);
    this.controller.signal.addEventListener('abort', () => {
      setState(undefined); setLive({ status: 'inactive', reason: 'disabled' }); events.clear();
    }, { once: true });
    void this.request('watch', { ipc: token.id }).then((event) => receive(event as NativeGuiEvent)).catch(() => {
      if (!this.controller.signal.aborted) setLive({ status: 'inactive', reason: 'failed' });
    });
    const entry = { value, live: liveAccessor(live) };
    this.tokens.set(token.id, entry as { value: Gui.IpcClient<Gui.IpcSpec>; live: Accessor<Gui.Live<Gui.IpcClient<Gui.IpcSpec>>> });
    return entry;
  }

  dispose(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(); this.stop(); this.listeners.clear(); this.tokens.clear();
    void requestNativeGui(this.bridge, 'release', { lease: this.activation.lease }).catch(() => {});
  }
}
