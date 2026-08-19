import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// buildInitScript lives inside main.mjs which imports electron — exercise the
// assignment-safe pattern with a local copy of the generated body.

const buildInitScriptBody = ({
  localOrigin = 'http://127.0.0.1:3901',
  bootOutcome = { target: 'local', status: 'ok' },
  apiBaseUrl = 'http://127.0.0.1:3901',
  clientToken = 'desktop-token',
  requestHeaders = {},
  packagedOrigin = 'openchamber-ui://app',
  macVersion = 15,
  home = '/Users/test',
} = {}) => {
  const local = JSON.stringify(localOrigin);
  const apiBase = JSON.stringify(apiBaseUrl);
  const token = JSON.stringify(clientToken);
  const headers = JSON.stringify(requestHeaders);
  const packaged = JSON.stringify(packagedOrigin);
  const outcome = JSON.stringify(bootOutcome ?? null);
  const homeJson = JSON.stringify(home);
  return [
    '(function(){',
    'var __oc_set=function(k,v){try{if(window[k]===undefined){window[k]=v;}}catch(_e){}};',
    `try{var __oc_local=${local};var __oc_api=${apiBase};var __oc_headers=${headers};var __oc_packaged=${packaged};var __oc_origin=window.location&&window.location.origin||'';var __oc_protocol=window.location&&window.location.protocol||'';var __oc_host=window.location&&window.location.hostname||'';var __oc_is_packaged=__oc_origin===__oc_packaged||__oc_protocol==='openchamber-ui:'||(__oc_protocol==='openchamber-ui:'&&__oc_host==='app');var __oc_is_local=false;try{__oc_is_local=!!(__oc_local&&__oc_origin===new URL(__oc_local).origin);}catch(_l){}__oc_set('__OPENCHAMBER_MACOS_MAJOR__',${macVersion});__oc_set('__OPENCHAMBER_LOCAL_ORIGIN__',__oc_local);__oc_set('__OPENCHAMBER_API_BASE_URL__',__oc_api);if(__oc_is_local||__oc_is_packaged){__oc_set('__OPENCHAMBER_HOME__',${homeJson});__oc_set('__OPENCHAMBER_RUNTIME_HEADERS__',__oc_headers);}if((__oc_is_local||__oc_is_packaged)&&${token}){__oc_set('__OPENCHAMBER_CLIENT_TOKEN__',${token});}var __oc_bo=${outcome};if(__oc_bo){try{window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__=__oc_bo;}catch(_bo){}}}catch(_e){}`,
    '}())',
  ].join('');
};

const runAgainstPreloadGlobals = (script, locationOrigin = 'http://127.0.0.1:3901') => {
  const window = {
    location: { origin: locationOrigin, protocol: 'http:', hostname: '127.0.0.1' },
  };
  // Mirror contextBridge: non-writable, non-configurable.
  for (const [key, value] of Object.entries({
    __OPENCHAMBER_MACOS_MAJOR__: 15,
    __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3901',
    __OPENCHAMBER_API_BASE_URL__: 'http://127.0.0.1:3901',
  })) {
    Object.defineProperty(window, key, {
      value,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
  vm.runInNewContext(script, { window, URL });
  return window;
};

describe('desktop initScript with contextBridge-read-only globals', () => {
  it('still injects boot outcome when preload globals are non-writable', () => {
    const window = runAgainstPreloadGlobals(buildInitScriptBody());
    expect(window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__).toEqual({ target: 'local', status: 'ok' });
    expect(window.__OPENCHAMBER_CLIENT_TOKEN__).toBe('desktop-token');
    expect(window.__OPENCHAMBER_HOME__).toBe('/Users/test');
    // Preload values remain intact.
    expect(window.__OPENCHAMBER_LOCAL_ORIGIN__).toBe('http://127.0.0.1:3901');
    expect(window.__OPENCHAMBER_API_BASE_URL__).toBe('http://127.0.0.1:3901');
  });

  it('can update boot outcome on a subsequent inject', () => {
    const window = runAgainstPreloadGlobals(buildInitScriptBody());
    const next = buildInitScriptBody({
      bootOutcome: { target: 'local', status: 'ok' },
      clientToken: 'next-token',
    });
    // Re-run with a different outcome payload.
    const refreshed = buildInitScriptBody({
      bootOutcome: { target: 'remote', status: 'ok', hostId: 'h1', url: 'https://example.com' },
    });
    vm.runInNewContext(refreshed, { window, URL });
    expect(window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__).toEqual({
      target: 'remote',
      status: 'ok',
      hostId: 'h1',
      url: 'https://example.com',
    });
    // Preload-owned token was already set; __oc_set does not clobber.
    expect(window.__OPENCHAMBER_CLIENT_TOKEN__).toBe('desktop-token');
    void next;
  });

  it('source buildInitScript uses per-key assignment helpers', async () => {
    const mainPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.mjs');
    const source = await readFile(mainPath, 'utf8');
    expect(source).toContain("var __oc_set=function(k,v){try{if(window[k]===undefined){window[k]=v;}}catch(_e){}};");
    expect(source).toContain("try{window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__=__oc_bo;}catch(_bo){}");
    // Must not reassign preload-owned keys in one monolithic try that aborts.
    expect(source).not.toMatch(
      /window\.__OPENCHAMBER_MACOS_MAJOR__=\$\{macVersion\};window\.__OPENCHAMBER_LOCAL_ORIGIN__=__oc_local;window\.__OPENCHAMBER_API_BASE_URL__=__oc_api;/,
    );
  });
});
