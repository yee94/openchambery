import { createRequire, isBuiltin } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mainModules } from '../ui/src/lib/gui-plugins/main-modules.mjs';
import errorMessages from '../ui/src/lib/gui-plugins/native-errors.json' with { type: 'json' };

const failure = (code) => Object.assign(new Error(errorMessages[code]), { name: 'GuiPluginError', code });

const nativeRequire = createRequire(import.meta.url);
const { Schema } = mainModules.effect;
const windowModules = new Set(['solid-js', 'solid-js/web', 'solid-js/store', '@opencode/client/solid',
  '@opencode/plugin/gui/file', '@opencode/plugin/gui/review', '@opencode/plugin/gui/browser']);
const unsupported = () => { throw failure('GUI_PLUGIN_UNSUPPORTED'); };
const partial = (value) => new Proxy(value, { get: (target, key) => key in target ? Reflect.get(target, key) : unsupported(String(key)) });
const inert = () => {
  const value = new Proxy(function () {}, { get: (_, key) => key === 'then' ? undefined : value, apply: () => value, construct: () => value });
  return value;
};
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024;

/** Only main's own server supplies code/options. Never accept them over IPC. */
export function evaluateMainBundle(code, requireNative = nativeRequire) {
  if (typeof code !== 'string' || Buffer.byteLength(code) > 16 * 1024 * 1024) throw new Error('Invalid GUI bundle');
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((name) => {
    if (Object.hasOwn(mainModules, name)) return mainModules[name];
    if (name === 'electron' || isBuiltin(name)) return requireNative(name);
    if (windowModules.has(name)) return inert();
    throw new Error(`Unsupported GUI shared module: ${name}`);
  }, module, module.exports);
  const definition = module.exports?.default ?? module.exports;
  if (!definition || (typeof definition.main !== 'function' && typeof definition.setup !== 'function')) throw new Error('Invalid GUI definition');
  if (definition.main !== undefined && typeof definition.main !== 'function') throw new Error('Invalid GUI main entry');
  return definition;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('GUI_PLUGIN_ABORTED'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** App-scoped main instances; document-scoped leases prevent stale/foreign IPC. */
export function createGuiPluginMainHost({ getClient, windows, app, authorize, authorizeWindow = authorize, send, requireNative, report = () => {} }) {
  const instances = new Map();
  const leases = new Map();
  const owners = new Map();
  const queues = new Map();
  const providers = new Map();
  const restricted = new Map();
  let sequence = 0;
  let disposed = false;
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  const enqueue = (id, run) => {
    const task = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
    queues.set(id, task);
    void task.finally(() => { if (queues.get(id) === task) queues.delete(id); }).catch(() => {});
    return task;
  };
  const snapshot = (ipc, owner) => {
    const provider = providers.get(ipc);
    return { type: 'state', ipc, sequence: ++sequence, available: !!provider,
      ...(provider?.token.spec.state ? { state: Schema.encodeSync(provider.token.spec.state)(provider.impl.state(owner.window.id)) } : {}) };
  };
  const publish = (ipc, event, window) => {
    for (const lease of leases.values()) {
      if (!lease.watches.has(ipc) || lease.owner.signal.aborted || (window !== undefined && lease.owner.window.id !== window)) continue;
      if (!authorized(lease.owner)) { lease.owner.forget(); continue; }
      try { send(lease.owner.window.webContents, { lease: lease.id, ...(event ?? snapshot(ipc, lease.owner)) }); }
      catch { report('GUI IPC notification failed'); }
    }
  };
  const clean = async (instance) => {
    instance.controller.abort();
    const cleanups = [...instance.cleanups].reverse();
    instance.cleanups.clear();
    let timer;
    await Promise.race([
      (async () => { for (const cleanup of cleanups) { try { await cleanup(); } catch { report('GUI main cleanup failed'); } } })(),
      new Promise((resolve) => { timer = setTimeout(resolve, 3000); }),
    ]);
    clearTimeout(timer);
  };
  const stop = async (instance) => {
    if (instance.stopping) return instance.stopping;
    if (instances.get(instance.id) === instance) instances.delete(instance.id);
    for (const lease of [...leases.values()]) if (lease.instance === instance) {
      try { send(lease.owner.window.webContents, { lease: lease.id, type: 'ended', ipc: '', sequence: ++sequence }); } catch { /* Window already closed. */ }
      lease.controller.abort();
      leases.delete(lease.id);
    }
    // Withdraw before awaiting user cleanup: no old IPC may run during teardown.
    for (const [ipc, provider] of providers) if (provider.instance === instance) { providers.delete(ipc); publish(ipc); }
    instance.stopping = clean(instance);
    await instance.stopping;
  };
  const release = async (lease) => {
    leases.delete(lease.id);
    lease.controller.abort();
    await enqueue(lease.instance.id, async () => {
      if (![...leases.values()].some((other) => other.instance === lease.instance)) await stop(lease.instance);
    });
  };
  const ownerFor = (event) => {
    if (restricted.has(event.sender)) throw failure('GUI_PLUGIN_DOCUMENT_RESTRICTED');
    if (disposed || !authorize(event)) throw failure('GUI_PLUGIN_FORBIDDEN');
    const contents = event.sender;
    let owner = owners.get(contents.id);
    if (owner) return owner;
    const controller = new AbortController();
    const window = windows.fromWebContents(contents);
    if (!window || window.webContents !== contents) throw failure('GUI_PLUGIN_FORBIDDEN');
    const forget = () => {
      controller.abort();
      owners.delete(contents.id);
      contents.removeListener('did-start-navigation', navigate);
      contents.removeListener('destroyed', forget);
      for (const lease of [...leases.values()]) if (lease.owner === owner) void release(lease).catch(() => report('GUI release failed'));
    };
    const navigate = (event) => { if (event.isMainFrame && !event.isSameDocument) forget(); };
    owner = { window, signal: controller.signal, forget };
    owners.set(contents.id, owner);
    contents.on('did-start-navigation', navigate);
    contents.once('destroyed', forget);
    return owner;
  };
  const authorized = (owner) => !disposed && !restricted.has(owner.window.webContents)
    && authorize({ sender: owner.window.webContents, senderFrame: owner.window.webContents.mainFrame });
  const assertOwner = (owner) => {
    if (owner.signal.aborted) throw failure('GUI_PLUGIN_LEASE_EXPIRED');
    if (!authorized(owner)) { owner.forget(); throw failure('GUI_PLUGIN_FORBIDDEN'); }
  };
  const context = (instance, definition) => {
    const own = (cleanup) => {
      let active = true;
      const run = () => { if (!active) return; active = false; instance.cleanups.delete(run); return cleanup(); };
      if (instance.controller.signal.aborted) void Promise.resolve().then(run).catch(() => report('GUI late cleanup failed'));
      else instance.cleanups.add(run);
      return run;
    };
    const validWindows = () => windows.getAllWindows().filter((win) => !win.isDestroyed()
      && authorize({ sender: win.webContents, senderFrame: win.webContents.mainFrame }));
    const translate = (key, params) => {
      const locale = app.getLocale();
      const messages = definition.i18n?.[locale] ?? definition.i18n?.[locale.split('-')[0]];
      return (messages?.[key] ?? definition.i18n?.en?.[key] ?? key).replace(/\{\{(\w+)\}\}/g, (match, name) => String(params?.[name] ?? match));
    };
    return partial({
      id: instance.id, options: instance.bundle.options, signal: instance.controller.signal,
      get client() { return getClient(); },
      app: { name: 'yuri', version: app.getVersion(), channel: app.isPackaged ? 'prod' : 'local', platform: 'desktop', packaged: app.isPackaged },
      onCleanup: (fn) => { if (typeof fn !== 'function') throw new Error('Invalid cleanup'); own(fn); },
      t: translate,
      plural: (key, count, params) => {
        const category = new Intl.PluralRules(app.getLocale()).select(count);
        const selected = `${key}.${category}`;
        const result = translate(selected, { ...params, count });
        return result === selected ? translate(`${key}.other`, { ...params, count }) : result;
      },
      log: { write: (level, message) => {
        if (!['debug', 'info', 'warn', 'error'].includes(level) || typeof message !== 'string') throw new Error('Invalid plugin diagnostic');
        // Native plugins can report diagnostics without copying their payloads into host logs.
        report('GUI plugin diagnostic', level);
      } },
      windows: {
        get: (id) => validWindows().find((win) => win.id === id), list: validWindows,
        focused: () => validWindows().find((win) => win.isFocused()),
        on: (event, handler) => {
          if (!['open', 'close'].includes(event) || typeof handler !== 'function') throw new Error('Invalid window subscription');
          const closeListeners = new Map();
          const wire = (win) => {
            if (event === 'open') handler(win);
            else { const close = () => { closeListeners.delete(win); handler(win); }; closeListeners.set(win, close); win.once('closed', close); }
          };
          if (event === 'close') validWindows().forEach(wire);
          const created = (_event, win) => {
            const loaded = () => { if (!instance.controller.signal.aborted && validWindows().includes(win)) wire(win); };
            win.webContents.once('did-finish-load', loaded);
            own(() => win.webContents.removeListener('did-finish-load', loaded));
          };
          app.on('browser-window-created', created);
          return own(() => { app.removeListener('browser-window-created', created); for (const [win, fn] of closeListeners) win.removeListener('closed', fn); });
        },
      },
      provide: (token, impl) => {
        if (token?.kind !== 'ipc' || !(token.id === instance.id || token.id.startsWith(`${instance.id}.`))) throw new Error('IPC must belong to the plugin');
        if (instance.controller.signal.aborted) throw new Error('GUI plugin stopped');
        if (providers.has(token.id)) throw new Error('IPC already provided');
        for (const method of Object.keys(token.spec.methods)) if (typeof impl[method] !== 'function') throw new Error(`Missing IPC method: ${method}`);
        if (token.spec.state && typeof impl.state !== 'function') throw new Error('Missing IPC state');
        const provider = { instance, token, impl };
        const live = () => providers.get(token.id) === provider;
        providers.set(token.id, provider);
        const dispose = own(() => { if (live()) { providers.delete(token.id); publish(token.id); } });
        publish(token.id);
        return {
          dispose,
          changed: (window) => { if (live()) publish(token.id, undefined, window); },
          emit: (name, data, window) => {
            if (!live()) return;
            const schema = token.spec.events?.[name];
            if (!schema) throw new Error('Unknown IPC event');
            try { publish(token.id, { type: 'event', ipc: token.id, sequence: ++sequence, name, data: Schema.encodeSync(schema)(data) }, window); }
            catch { report('GUI IPC event encoding failed'); }
          },
        };
      },
    });
  };

  const host = {
    isWindowOnly: (contents) => restricted.has(contents),
    invalidateWindow(contents) { owners.get(contents.id)?.forget(); },
    async dispatch(event, action, input) {
      try { return { ok: true, value: await host.handle(event, action, input) }; }
      catch (error) {
        const code = typeof error?.code === 'string' && Object.hasOwn(errorMessages, error.code) ? error.code : 'GUI_PLUGIN_FAILED';
        report(code);
        return { ok: false, error: { code, message: errorMessages[code] } };
      }
    },
    async handle(event, action, input = {}) {
      if (action === 'window-only') {
        if (disposed || !authorizeWindow(event) || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw failure('GUI_PLUGIN_FORBIDDEN');
        const contents = event.sender;
        if (!restricted.has(contents)) {
          const clear = () => {
            restricted.delete(contents);
            contents.removeListener('did-navigate', clear);
            contents.removeListener('destroyed', clear);
          };
          restricted.set(contents, clear);
          // did-navigate means a committed main-frame document, unlike DOM readiness
          // or a provisional navigation that may be cancelled while old code survives.
          contents.once('did-navigate', clear);
          contents.once('destroyed', clear);
        }
        host.invalidateWindow(contents);
        return;
      }
      const owner = ownerFor(event);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('GUI_PLUGIN_INVALID_REQUEST');
      if (action === 'acquire') {
        if (!text(input.id) || !text(input.revision)) throw failure('GUI_PLUGIN_INVALID_REQUEST');
        return enqueue(input.id, async () => {
          assertOwner(owner);
          const client = getClient();
          const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(15000)]);
          const inventory = (await client.plugin.list(undefined, { signal })).data;
          const listed = inventory.find((item) => item.id === input.id && item.features.gui && item.state.status === 'active');
          if (!listed) {
            const old = instances.get(input.id); if (old) await stop(old);
            throw failure('GUI_PLUGIN_UNAVAILABLE');
          }
          const bundle = (await client.plugin.gui({ id: input.id }, { signal })).data;
          assertOwner(owner);
          if (bundle.revision !== input.revision) throw failure('GUI_PLUGIN_REVISION_MISMATCH');
          let instance = instances.get(input.id);
          if (instance?.bundle.revision !== bundle.revision) {
            // Validate the replacement before withdrawing the current instance.
            const definition = evaluateMainBundle(bundle.code, requireNative);
            if (definition.os && (!Array.isArray(definition.os) || !definition.os.includes(os))) throw failure('GUI_PLUGIN_UNSUPPORTED');
            if (instance) await stop(instance);
            assertOwner(owner);
            instance = { id: input.id, bundle, controller: new AbortController(), cleanups: new Set() };
            instances.set(instance.id, instance);
            try {
              const ready = Promise.resolve(definition.main?.(context(instance, definition))).then((cleanup) => {
                if (cleanup !== undefined && typeof cleanup !== 'function') throw new Error('Invalid GUI main cleanup');
                if (cleanup) {
                  if (instance.controller.signal.aborted) return cleanup();
                  instance.cleanups.add(cleanup);
                }
              });
              await abortable(ready, AbortSignal.any([signal, instance.controller.signal]));
              assertOwner(owner);
            } catch (error) { await stop(instance); throw error; }
          }
          const id = randomUUID();
          leases.set(id, { id, instance, owner, controller: new AbortController(), watches: new Set(), calls: new Map() });
          return { lease: id, bundle, os, app: { version: app.getVersion(), packaged: app.isPackaged } };
        });
      }
      const lease = leases.get(input.lease);
      if (!lease || lease.owner !== owner) throw failure('GUI_PLUGIN_LEASE_EXPIRED');
      if (action === 'release') { await release(lease); return; }
      if (action === 'cancel') { lease.calls.get(input.request)?.abort(); return; }
      if (!text(input.ipc)) throw failure('GUI_PLUGIN_INVALID_REQUEST');
      if (action === 'watch') { lease.watches.add(input.ipc); return snapshot(input.ipc, owner); }
      if (action !== 'call' || !text(input.method) || !text(input.request)) throw failure('GUI_PLUGIN_INVALID_REQUEST');
      const provider = providers.get(input.ipc);
      if (!provider) throw failure('GUI_PLUGIN_UNAVAILABLE');
      const spec = Object.hasOwn(provider.token.spec.methods, input.method) && provider.token.spec.methods[input.method];
      if (!spec) throw failure('GUI_PLUGIN_UNKNOWN_METHOD');
      if (lease.calls.has(input.request)) throw failure('GUI_PLUGIN_INVALID_REQUEST');
      const controller = new AbortController();
      lease.calls.set(input.request, controller);
      const signal = AbortSignal.any([controller.signal, lease.controller.signal, owner.signal, provider.instance.controller.signal]);
      try {
        return await abortable((async () => {
          const value = spec.input ? await Schema.decodeUnknownPromise(spec.input)(input.input).catch(() => { throw failure('GUI_PLUGIN_INVALID_INPUT'); }) : undefined;
          signal.throwIfAborted(); assertOwner(owner);
          if (providers.get(input.ipc) !== provider) throw failure('GUI_PLUGIN_UNAVAILABLE');
          const result = await provider.impl[input.method](value, { window: owner.window.id, signal });
          signal.throwIfAborted(); assertOwner(owner);
          const encoded = spec.output ? await Schema.encodeUnknownPromise(spec.output)(result).catch(() => { throw failure('GUI_PLUGIN_INVALID_OUTPUT'); }) : undefined;
          signal.throwIfAborted(); assertOwner(owner);
          return encoded;
        })(), signal);
      } finally { lease.calls.delete(input.request); }
    },
    async dispose() {
      disposed = true;
      for (const clear of [...restricted.values()]) clear();
      for (const owner of [...owners.values()]) owner.forget();
      await Promise.all([...instances.values()].map(stop));
      await Promise.allSettled([...queues.values()]);
    },
  };
  return host;
}
