import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  ELECTRON_DEV_STRIPPED_ENV_KEYS,
  buildElectronDevChildEnv,
} from './electron-dev-env.mjs';

describe('electron-dev-env', () => {
  it('strips production OpenChamber/OpenCode leakage keys', () => {
    const env = buildElectronDevChildEnv({
      PATH: '/usr/bin',
      OPENCHAMBER_UI_PASSWORD: 'prod-secret',
      OPENCHAMBER_DIST_DIR: '/Applications/OpenChamber.app/Contents/Resources/web-dist',
      OPENCHAMBER_RUNTIME: 'desktop',
      OPENCHAMBER_HOST: '0.0.0.0',
      OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE: 'true',
      OPENCHAMBER_DESKTOP_NOTIFY: 'true',
      OPENCHAMBER_OPENCODE_CWD: '/Users/prod',
      OPENCODE_SERVER_PASSWORD: 'managed-secret',
      OPENCODE_CONFIG_CONTENT: '{"plugin":[]}',
      OPENCODE_PID: '123',
      OPENCODE: '1',
      KEEP_ME: 'yes',
    }, {
      OPENCHAMBER_ELECTRON_DEV: '1',
      OPENCHAMBER_HMR_UI_PORT: '5173',
    });

    for (const key of ELECTRON_DEV_STRIPPED_ENV_KEYS) {
      if (key === 'OPENCHAMBER_HOST') continue; // re-defaulted below
      assert.equal(env[key], undefined, `expected ${key} stripped`);
    }
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.KEEP_ME, 'yes');
    assert.equal(env.OPENCHAMBER_ELECTRON_DEV, '1');
    assert.equal(env.OPENCHAMBER_HMR_UI_PORT, '5173');
    // Production 0.0.0.0 must not stick; loopback is the safe default.
    assert.equal(env.OPENCHAMBER_HOST, '127.0.0.1');
  });

  it('allows explicit overrides after stripping', () => {
    const env = buildElectronDevChildEnv({
      OPENCHAMBER_UI_PASSWORD: 'prod-secret',
      OPENCHAMBER_HOST: '0.0.0.0',
    }, {
      OPENCHAMBER_HOST: '127.0.0.1',
      OPENCHAMBER_ELECTRON_DEV: '1',
    });
    assert.equal(env.OPENCHAMBER_UI_PASSWORD, undefined);
    assert.equal(env.OPENCHAMBER_HOST, '127.0.0.1');
    assert.equal(env.OPENCHAMBER_ELECTRON_DEV, '1');
  });
});
