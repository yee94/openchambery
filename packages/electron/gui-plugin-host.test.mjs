import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createGuiPluginMainHost, evaluateMainBundle } from './gui-plugin-host.mjs';

const code = (main = '') => `
  const {Plugin,Ipc}=require('@opencode/plugin/gui');
  const {Schema}=require('effect');
  const native=require('electron');
  const Test=Ipc.define({id:'test.api', state:Schema.Number, events:{changed:Schema.Number}, methods:{
    add:{input:Schema.Number,output:Schema.Number}, bad:{output:Schema.Number}, wait:{output:Schema.Boolean}
  }});
  module.exports=Plugin.define({setup(){},main(ctx){
    native.started++;
    let count=0;
    const p=ctx.provide(Test,{
      state:window=>count+window,
      add:(n,caller)=>{count+=n;p.changed(caller.window);p.emit('changed',count,caller.window);return count},
      bad:()=> 'invalid',
      wait:(_,caller)=>new Promise(resolve=>caller.signal.addEventListener('abort',()=>{native.aborted++;resolve(true)}))
    });
    ctx.onCleanup(()=>{native.stopped++});
    ${main}
  }});
`;

function fixture(source = code()) {
  const native = { started: 0, stopped: 0, aborted: 0 };
  const allWindows = [];
  const app = Object.assign(new EventEmitter(), { getLocale: () => 'en', getVersion: () => '1', isPackaged: false });
  let bundle = { code: source, revision: 'r1', options: {} };
  const client = { plugin: {
    list: vi.fn(async () => ({ data: [{ id: 'test', features: { gui: true }, state: { status: 'active' } }] })),
    gui: vi.fn(async () => ({ data: bundle })),
  } };
  const send = vi.fn();
  const report = vi.fn();
  const host = createGuiPluginMainHost({
    getClient: () => client, app, send, report, requireNative: () => native,
    windows: { fromWebContents: (contents) => allWindows.find((win) => win.webContents === contents), getAllWindows: () => allWindows },
    authorize: (event) => event.sender.local && event.senderFrame === event.sender.mainFrame,
  });
  const window = (id) => {
    const contents = Object.assign(new EventEmitter(), { id, local: true, mainFrame: {} });
    const win = Object.assign(new EventEmitter(), { id, webContents: contents, isDestroyed: () => false });
    allWindows.push(win);
    return { sender: contents, senderFrame: contents.mainFrame };
  };
  const first = window(1);
  const acquire = (event = first, revision = 'r1') => host.handle(event, 'acquire', { id: 'test', revision });
  const call = (lease, method, input, event = first, request = crypto.randomUUID()) => host.handle(event, 'call', { lease, ipc: 'test.api', method, input, request });
  return { host, native, client, send, report, first, window, acquire, call, replace: (source, revision) => { bundle = { code: source, revision, options: {} }; } };
}

describe('trusted native GUI plugin host', () => {
  it('returns refusal envelopes and records stable codes, not request payloads', async () => {
    const f = fixture();
    try {
      const denied = await f.host.dispatch({ ...f.first, senderFrame: {} }, 'acquire', { id: 'test', revision: 'r1', secret: 'not-a-log' });
      expect(denied).toMatchObject({ ok: false, error: { code: 'GUI_PLUGIN_FORBIDDEN' } });
      expect(f.report).toHaveBeenCalledExactlyOnceWith('GUI_PLUGIN_FORBIDDEN');
      const a = await f.acquire();
      expect(await f.host.dispatch(f.first, 'call', { lease: a.lease, ipc: 'test.api', method: 'add', request: 'bad', input: 'wrong' }))
        .toMatchObject({ ok: false, error: { code: 'GUI_PLUGIN_INVALID_INPUT' } });
      expect(await f.host.dispatch(f.first, 'call', { lease: a.lease, ipc: 'test.api', method: 'bad', request: 'bad-output' }))
        .toMatchObject({ ok: false, error: { code: 'GUI_PLUGIN_INVALID_OUTPUT' } });
    } finally { await f.host.dispose(); }
  });

  it('window-only mode revokes native work for the document while other windows remain usable', async () => {
    const f = fixture(); const second = f.window(2);
    try {
      const a = await f.acquire(); const b = await f.acquire(second);
      const pending = expect(f.call(a.lease, 'wait')).rejects.toMatchObject({ code: 'GUI_PLUGIN_ABORTED' });
      await f.host.handle(f.first, 'window-only');
      await pending;
      expect(f.host.isWindowOnly(f.first.sender)).toBe(true);
      expect(await f.call(b.lease, 'add', 1, second)).toBe(1);
      await expect(f.acquire()).rejects.toMatchObject({ code: 'GUI_PLUGIN_DOCUMENT_RESTRICTED' });
      f.first.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
      f.first.sender.emit('dom-ready');
      expect(f.host.isWindowOnly(f.first.sender)).toBe(true);
      f.first.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      await expect(f.acquire()).rejects.toMatchObject({ code: 'GUI_PLUGIN_DOCUMENT_RESTRICTED' });
      f.first.sender.emit('dom-ready');
      expect(f.host.isWindowOnly(f.first.sender)).toBe(true);
      f.first.sender.emit('did-navigate', {}, 'https://app.example', 200, 'OK');
      expect(f.host.isWindowOnly(f.first.sender)).toBe(false);
      const fresh = await f.acquire();
      expect(fresh.lease).not.toBe(a.lease);
    } finally { await f.host.dispose(); }
  });

  it('revalidates outgoing events and revokes leases after runtime trust is lost', async () => {
    const f = fixture(code("native.changed=()=>p.changed();")); const second = f.window(2);
    try {
      const a = await f.acquire(); const b = await f.acquire(second);
      await f.host.handle(f.first, 'watch', { lease: a.lease, ipc: 'test.api' });
      await f.host.handle(second, 'watch', { lease: b.lease, ipc: 'test.api' });
      f.first.sender.local = false;
      f.native.changed();
      expect(f.send.mock.calls.filter(([contents]) => contents === f.first.sender)).toHaveLength(0);
      expect(f.send.mock.calls.filter(([contents]) => contents === second.sender)).toHaveLength(1);
      f.first.sender.local = true;
      await expect(f.call(a.lease, 'add', 1)).rejects.toMatchObject({ code: 'GUI_PLUGIN_LEASE_EXPIRED' });
    } finally { await f.host.dispose(); }
  });

  it('runs main once across windows, validates codecs, scopes state/events and stops after the last lease', async () => {
    const f = fixture(); const second = f.window(2);
    try {
      const a = await f.acquire(); const b = await f.acquire(second);
      expect(f.native.started).toBe(1);
      expect(await f.host.handle(f.first, 'watch', { lease: a.lease, ipc: 'test.api' })).toMatchObject({ state: 1 });
      await f.host.handle(second, 'watch', { lease: b.lease, ipc: 'test.api' });
      expect(await f.call(a.lease, 'add', 4)).toBe(4);
      expect(f.send.mock.calls.map(([, event]) => event)).toEqual([
        expect.objectContaining({ lease: a.lease, type: 'state', state: 5 }),
        expect.objectContaining({ lease: a.lease, type: 'event', name: 'changed', data: 4 }),
      ]);
      await expect(f.call(a.lease, 'add', 'wrong')).rejects.toThrow();
      await expect(f.call(a.lease, 'bad')).rejects.toThrow();
      await expect(f.call(a.lease, 'toString')).rejects.toMatchObject({ code: 'GUI_PLUGIN_UNKNOWN_METHOD' });
      await expect(f.call(a.lease, 'add', 1, second)).rejects.toMatchObject({ code: 'GUI_PLUGIN_LEASE_EXPIRED' });
      await f.host.handle(f.first, 'release', { lease: a.lease });
      expect(f.native.stopped).toBe(0);
      await f.host.handle(second, 'release', { lease: b.lease });
      expect(f.native.stopped).toBe(1);
    } finally { await f.host.dispose(); }
  });

  it('rejects remote pages and child frames before reading any plugin code', async () => {
    const f = fixture();
    try {
      await expect(f.acquire({ ...f.first, senderFrame: {} })).rejects.toMatchObject({ code: 'GUI_PLUGIN_FORBIDDEN' });
      f.first.sender.local = false;
      await expect(f.acquire()).rejects.toMatchObject({ code: 'GUI_PLUGIN_FORBIDDEN' });
      expect(f.client.plugin.list).not.toHaveBeenCalled();
    } finally { await f.host.dispose(); }
  });

  it('reads code/options itself, rejects stale revisions and inactive inventory', async () => {
    const f = fixture();
    try {
      await expect(f.acquire(f.first, 'renderer-revision')).rejects.toThrow('revision');
      expect(f.native.started).toBe(0);
      const a = await f.host.handle(f.first, 'acquire', { id: 'test', revision: 'r1', code: 'throw 1', options: { hacked: true } });
      expect(a.bundle.options).toEqual({});
      f.client.plugin.list.mockResolvedValueOnce({ data: [] });
      await expect(f.acquire()).rejects.toMatchObject({ code: 'GUI_PLUGIN_UNAVAILABLE' });
      expect(f.native.stopped).toBe(1);
      await expect(f.call(a.lease, 'add', 1)).rejects.toMatchObject({ code: 'GUI_PLUGIN_LEASE_EXPIRED' });
    } finally { await f.host.dispose(); }
  });

  it('retains the running revision on fetch/evaluation failure, then revokes old leases on replacement', async () => {
    const f = fixture();
    try {
      const a = await f.acquire();
      f.client.plugin.gui.mockRejectedValueOnce(new Error('offline'));
      await expect(f.acquire()).rejects.toThrow('offline');
      expect(await f.call(a.lease, 'add', 1)).toBe(1);
      f.replace('throw new Error("bad bundle")', 'r2');
      await expect(f.acquire(f.first, 'r2')).rejects.toThrow('bad bundle');
      expect(f.native.stopped).toBe(0);
      f.replace(code(), 'r2');
      const b = await f.acquire(f.first, 'r2');
      expect(f.native.started).toBe(2); expect(f.native.stopped).toBe(1);
      await expect(f.call(a.lease, 'add', 1)).rejects.toMatchObject({ code: 'GUI_PLUGIN_LEASE_EXPIRED' });
      expect(await f.call(b.lease, 'add', 2)).toBe(2);
    } finally { await f.host.dispose(); }
  });

  it('cancels per-call work and aborts every outstanding call on navigation', async () => {
    const f = fixture();
    try {
      const a = await f.acquire();
      const pending = f.call(a.lease, 'wait', undefined, f.first, 'request');
      const rejected = expect(pending).rejects.toThrow('aborted');
      await f.host.handle(f.first, 'cancel', { lease: a.lease, request: 'request' });
      await rejected;
      expect(f.native.aborted).toBe(1);
      const second = f.call(a.lease, 'wait');
      const navigation = expect(second).rejects.toThrow('aborted');
      f.first.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      await navigation;
      await expect(f.call(a.lease, 'add', 1)).rejects.toMatchObject({ code: 'GUI_PLUGIN_LEASE_EXPIRED' });
      expect(f.native.aborted).toBe(2);
    } finally { await f.host.dispose(); }
  });

  it('does not execute code from an acquire that outlived its document', async () => {
    const f = fixture(); let finish;
    f.client.plugin.gui.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    try {
      const pending = f.acquire();
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      f.first.sender.emit('destroyed');
      finish({ data: { code: code(), revision: 'r1', options: {} } });
      await expect(pending).rejects.toThrow();
      expect(f.native.started).toBe(0);
    } finally { await f.host.dispose(); }
  });

  it('cleans partial setup failure and rejects foreign providers', async () => {
    const f = fixture(code("ctx.provide(Ipc.define({id:'foreign',methods:{}}),{});"));
    try {
      await expect(f.acquire()).rejects.toThrow('belong');
      expect(f.native.stopped).toBe(1);
    } finally { await f.host.dispose(); }
  });

  it('evaluates the standard CJS ABI with inert renderer modules and real Node builtins', () => {
    const plugin = evaluateMainBundle(`
      const web=require('solid-js/web'); web.template('x')();
      const {Plugin}=require('@opencode/plugin/gui');
      const path=require('node:path');
      module.exports=Plugin.define({main(){return path.basename('/a/b')}});
    `);
    expect(plugin.main()).toBe('b');
    expect(() => evaluateMainBundle("require('arbitrary-package')")).toThrow('Unsupported GUI');
  });
});
