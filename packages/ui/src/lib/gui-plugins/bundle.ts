import * as sdk from '@opencode/plugin/gui';
import * as file from '@opencode/plugin/gui/file';
import * as review from '@opencode/plugin/gui/review';
import * as browser from '@opencode/plugin/gui/browser';
import * as rpc from '@opencode/plugin/rpc';
import * as rpcSchema from '@yuriai/opencode-gui-schema/rpc';
import * as client from '@yuriai/opencode-gui-client';
import * as effectClient from '@yuriai/opencode-gui-client/effect';
import * as solidClient from '@yuriai/opencode-gui-client/solid';
import * as effect from 'effect';
import * as solid from 'solid-js';
import * as web from 'solid-js/web';
import * as store from 'solid-js/store';

const modules: Record<string, object> = {
  '@opencode/plugin/gui': sdk,
  '@opencode/plugin/gui/main': sdk,
  '@opencode/plugin/gui/file': file,
  '@opencode/plugin/gui/review': review,
  '@opencode/plugin/gui/browser': browser,
  '@opencode/plugin/rpc': rpc,
  '@opencode/schema/rpc': rpcSchema,
  '@opencode/client': client,
  '@opencode/client/effect': effectClient,
  '@opencode/client/solid': solidClient,
  effect,
  'solid-js': solid,
  'solid-js/web': web,
  'solid-js/store': store,
};

const nodeModules = new Set('assert assert/strict async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns dns/promises domain events fs fs/promises http http2 https inspector inspector/promises module net os path path/posix path/win32 perf_hooks process punycode querystring readline readline/promises repl stream stream/consumers stream/promises stream/web string_decoder sys timers timers/promises tls trace_events tty url util util/types v8 vm wasi worker_threads zlib'.split(' '));

// The upstream bundle evaluates both entries. Hoisted Node requires/templates must
// be inert in a window; this is compatibility plumbing, not a security sandbox.
function inert(): object {
  const placeholder: object = new Proxy(function () {}, {
    get: (_, key) => key === 'then' ? undefined
      : key === Symbol.hasInstance ? () => false
      : key === Symbol.toPrimitive || key === 'toString' ? () => '[main-only module]' : placeholder,
    apply: () => placeholder,
    construct: () => placeholder,
    set: () => true,
  });
  return placeholder;
}

export function evaluateGuiBundle(code: string): sdk.Plugin.Definition {
  if (code.length > 16 * 1024 * 1024) throw new Error('GUI bundle exceeds 16 MiB');
  const module: { exports: unknown } = { exports: {} };
  const requireModule = (name: string) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    if (name === 'electron' || name.startsWith('node:') || nodeModules.has(name)) return inert();
    throw new Error(`Unsupported GUI shared module: ${name}`);
  };
  // OpenCode's public format is one prebuilt CommonJS file, never source JSX.
  new Function('require', 'module', 'exports', code)(requireModule, module, module.exports);
  const exported = module.exports;
  const definition = exported && typeof exported === 'object' && 'default' in exported ? exported.default : exported;
  if (!definition || typeof definition !== 'object') throw new Error('GUI bundle must default-export Plugin.define');
  if (!('setup' in definition) || typeof definition.setup !== 'function') {
    throw new Error('This host requires a window setup; main-only plugins are unsupported');
  }
  if ('os' in definition && definition.os !== undefined) {
    throw new Error('OS-restricted plugins require the native GUI host');
  }
  if ('main' in definition && definition.main !== undefined && typeof definition.main !== 'function') {
    throw new Error('Invalid GUI main entry');
  }
  if ('stores' in definition && definition.stores !== undefined) {
    if (!definition.stores || typeof definition.stores !== 'object' || Array.isArray(definition.stores)) throw new Error('Invalid GUI stores');
    for (const store of Object.values(definition.stores)) {
      if (!store || typeof store !== 'object' || !('schema' in store) || !effect.Schema.isSchema(store.schema)
        || !('scope' in store) || !['global', 'session'].includes(String(store.scope)) || !('initial' in store)) {
        throw new Error('Invalid GUI store declaration');
      }
    }
  }
  if ('i18n' in definition && definition.i18n !== undefined) {
    if (!definition.i18n || typeof definition.i18n !== 'object' || Array.isArray(definition.i18n)) throw new Error('Invalid GUI locale catalog');
    for (const messages of Object.values(definition.i18n)) {
      if (!messages || typeof messages !== 'object' || Array.isArray(messages)
        || Object.values(messages).some((value) => typeof value !== 'string')) throw new Error('GUI locales must be inline string dictionaries');
    }
  }
  // The CJS boundary can validate function presence and declaration shapes, not
  // a third-party callback's TypeScript signature. The host isolates its execution.
  return definition as sdk.Plugin.Definition;
}
