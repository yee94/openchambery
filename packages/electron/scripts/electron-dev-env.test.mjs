import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  ELECTRON_DEV_STRIPPED_ENV_KEYS,
  buildElectronDevChildEnv,
} from './electron-dev-env.mjs';

describe('electron-dev-env', () => {
  it('strips production Yuri/OpenCode leakage keys', () => {
    const env = buildElectronDevChildEnv({
      PATH: '/usr/bin',
      YURI_UI_PASSWORD: 'prod-secret',
      YURI_DIST_DIR: '/Applications/Yuri.app/Contents/Resources/web-dist',
      YURI_RUNTIME: 'desktop',
      YURI_HOST: '0.0.0.0',
      YURI_DESKTOP_LAN_ACCESS_ACTIVE: 'true',
      YURI_DESKTOP_NOTIFY: 'true',
      YURI_OPENCODE_CWD: '/Users/prod',
      OPENCODE_SERVER_PASSWORD: 'managed-secret',
      OPENCODE_CONFIG_CONTENT: '{"plugin":[]}',
      OPENCODE_PID: '123',
      OPENCODE: '1',
      KEEP_ME: 'yes',
    }, {
      YURI_ELECTRON_DEV: '1',
      YURI_HMR_UI_PORT: '5173',
    });

    for (const key of ELECTRON_DEV_STRIPPED_ENV_KEYS) {
      if (key === 'YURI_HOST') continue; // re-defaulted below
      assert.equal(env[key], undefined, `expected ${key} stripped`);
    }
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.KEEP_ME, 'yes');
    assert.equal(env.YURI_ELECTRON_DEV, '1');
    assert.equal(env.YURI_HMR_UI_PORT, '5173');
    // Production 0.0.0.0 must not stick; loopback is the safe default.
    assert.equal(env.YURI_HOST, '127.0.0.1');
  });

  it('allows explicit overrides after stripping', () => {
    const env = buildElectronDevChildEnv({
      YURI_UI_PASSWORD: 'prod-secret',
      YURI_HOST: '0.0.0.0',
    }, {
      YURI_HOST: '127.0.0.1',
      YURI_ELECTRON_DEV: '1',
    });
    assert.equal(env.YURI_UI_PASSWORD, undefined);
    assert.equal(env.YURI_HOST, '127.0.0.1');
    assert.equal(env.YURI_ELECTRON_DEV, '1');
  });
});
