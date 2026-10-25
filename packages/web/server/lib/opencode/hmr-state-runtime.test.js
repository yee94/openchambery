import { describe, expect, it } from 'vitest';

import { createHmrStateRuntime } from './hmr-state-runtime.js';

const createRuntime = (env = {}) => createHmrStateRuntime({
  globalThisLike: {},
  os: { homedir: () => '/Users/example' },
  processLike: { env },
  stateKey: '__testHmrState',
});

describe('hmr state runtime', () => {
  it('uses configured OpenCode cwd when provided', () => {
    const runtime = createRuntime({ YURI_OPENCODE_CWD: '/tmp/yuri-data' });

    expect(runtime.getOrCreateHmrState().openCodeWorkingDirectory).toBe('/tmp/yuri-data');
  });

  it('falls back to home directory without configured OpenCode cwd', () => {
    const runtime = createRuntime();

    expect(runtime.getOrCreateHmrState().openCodeWorkingDirectory).toBe('/Users/example');
  });

  it('synchronizes managed capability identity across HMR state', () => {
    const runtime = createRuntime();
    const state = runtime.getOrCreateHmrState();
    const identity = { version: '1', origin: 'http://127.0.0.1:3000', token: 'a'.repeat(64), childPid: 42 };
    runtime.syncStateFromRuntime(state, { managedCapabilityIdentity: identity });
    expect(runtime.restoreRuntimeFromState({ hmrState: state, userProvidedOpenCodePassword: null }).managedCapabilityIdentity).toEqual(identity);
  });

  it('synchronizes external OpenCode ownership across HMR state', () => {
    const runtime = createRuntime();
    const state = runtime.getOrCreateHmrState();
    runtime.syncStateFromRuntime(state, { isExternalOpenCode: true });
    expect(runtime.restoreRuntimeFromState({ hmrState: state, userProvidedOpenCodePassword: null }).isExternalOpenCode).toBe(true);
  });
});
