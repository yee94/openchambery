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
  packagedOrigin = 'yuri-ui://app',
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
    'var __yuri_set=function(k,v){try{if(window[k]===undefined){window[k]=v;}}catch(_e){}};',
    `try{var __yuri_local=${local};var __yuri_api=${apiBase};var __yuri_headers=${headers};var __yuri_packaged=${packaged};var __yuri_origin=window.location&&window.location.origin||'';var __yuri_protocol=window.location&&window.location.protocol||'';var __yuri_host=window.location&&window.location.hostname||'';var __yuri_is_packaged=__yuri_origin===__yuri_packaged||__yuri_protocol==='yuri-ui:'||(__yuri_protocol==='yuri-ui:'&&__yuri_host==='app');var __yuri_is_local=false;try{__yuri_is_local=!!(__yuri_local&&__yuri_origin===new URL(__yuri_local).origin);}catch(_l){}__yuri_set('__YURI_MACOS_MAJOR__',${macVersion});__yuri_set('__YURI_LOCAL_ORIGIN__',__yuri_local);__yuri_set('__YURI_API_BASE_URL__',__yuri_api);if(__yuri_is_local||__yuri_is_packaged){__yuri_set('__YURI_HOME__',${homeJson});__yuri_set('__YURI_RUNTIME_HEADERS__',__yuri_headers);}if((__yuri_is_local||__yuri_is_packaged)&&${token}){__yuri_set('__YURI_CLIENT_TOKEN__',${token});}var __yuri_bo=${outcome};if(__yuri_bo){try{window.__YURI_DESKTOP_BOOT_OUTCOME__=__yuri_bo;}catch(_bo){}}}catch(_e){}`,
    '}())',
  ].join('');
};

const runAgainstPreloadGlobals = (script, locationOrigin = 'http://127.0.0.1:3901') => {
  const window = {
    location: { origin: locationOrigin, protocol: 'http:', hostname: '127.0.0.1' },
  };
  // Mirror contextBridge: non-writable, non-configurable.
  for (const [key, value] of Object.entries({
    __YURI_MACOS_MAJOR__: 15,
    __YURI_LOCAL_ORIGIN__: 'http://127.0.0.1:3901',
    __YURI_API_BASE_URL__: 'http://127.0.0.1:3901',
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
    expect(window.__YURI_DESKTOP_BOOT_OUTCOME__).toEqual({ target: 'local', status: 'ok' });
    expect(window.__YURI_CLIENT_TOKEN__).toBe('desktop-token');
    expect(window.__YURI_HOME__).toBe('/Users/test');
    // Preload values remain intact.
    expect(window.__YURI_LOCAL_ORIGIN__).toBe('http://127.0.0.1:3901');
    expect(window.__YURI_API_BASE_URL__).toBe('http://127.0.0.1:3901');
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
    expect(window.__YURI_DESKTOP_BOOT_OUTCOME__).toEqual({
      target: 'remote',
      status: 'ok',
      hostId: 'h1',
      url: 'https://example.com',
    });
    // Preload-owned token was already set; __yuri_set does not clobber.
    expect(window.__YURI_CLIENT_TOKEN__).toBe('desktop-token');
    void next;
  });

  it('source buildInitScript uses per-key assignment helpers', async () => {
    const mainPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.mjs');
    const source = await readFile(mainPath, 'utf8');
    expect(source).toContain("var __yuri_set=function(k,v){try{if(window[k]===undefined){window[k]=v;}}catch(_e){}};");
    expect(source).toContain("try{window.__YURI_DESKTOP_BOOT_OUTCOME__=__yuri_bo;}catch(_bo){}");
    // Must not reassign preload-owned keys in one monolithic try that aborts.
    expect(source).not.toMatch(
      /window\.__YURI_MACOS_MAJOR__=\$\{macVersion\};window\.__YURI_LOCAL_ORIGIN__=__yuri_local;window\.__YURI_API_BASE_URL__=__yuri_api;/,
    );
  });
});
