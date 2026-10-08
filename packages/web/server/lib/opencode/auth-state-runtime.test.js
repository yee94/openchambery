import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createOpenCodeAuthStateRuntime } from './auth-state-runtime.js';
import { createHmrStateRuntime } from './hmr-state-runtime.js';

const setup = (env = {}) => {
  const processLike = { env: { ...env } };
  const hmr = createHmrStateRuntime({ globalThisLike: {}, os: { homedir: () => '/example' }, processLike, stateKey: 'test' });
  const state = hmr.getOrCreateHmrState();
  hmr.ensureUserProvidedOpenCodePassword(state);
  const restore = () => hmr.restoreRuntimeFromState({ hmrState: state, userProvidedOpenCodePassword: hmr.getUserProvidedOpenCodePassword(state) });
  const runtimeState = restore();
  const auth = createOpenCodeAuthStateRuntime({ crypto, process: processLike,
    getAuthPassword: () => runtimeState.openCodeAuthPassword,
    setAuthPassword: (value) => { runtimeState.openCodeAuthPassword = value; },
    getAuthSource: () => runtimeState.openCodeAuthSource,
    setAuthSource: (value) => { runtimeState.openCodeAuthSource = value; },
    getUserProvidedPassword: () => hmr.getUserProvidedOpenCodePassword(state),
    syncToHmrState: () => hmr.syncStateFromRuntime(state, runtimeState),
  });
  return { auth, restore, runtimeState, processLike, hmr, state };
};

describe('OpenCode auth ownership', () => {
  it('uses v2 before legacy credentials and preserves the captured choice through HMR/restart', async () => {
    const test = setup({ OPENCODE_PASSWORD: 'v2-fixture', OPENCODE_SERVER_PASSWORD: 'legacy-fixture' });
    const password = await test.auth.ensureLocalOpenCodeServerPassword({ rotateManaged: true });
    expect(password === 'v2-fixture').toBe(true);
    expect(test.auth.getOpenCodeAuthHeaders().Authorization === `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`).toBe(true);
    test.processLike.env.OPENCODE_PASSWORD = 'later-shell-fixture';
    test.hmr.ensureUserProvidedOpenCodePassword(test.state);
    expect((await test.auth.ensureLocalOpenCodeServerPassword({ rotateManaged: true })) === password).toBe(true);
    expect(test.restore().openCodeAuthPassword === password).toBe(true);
  });

  it('rotates generated credentials while old credentials fail a controlled auth check', async () => {
    const { auth, restore } = setup();
    const old = await auth.ensureLocalOpenCodeServerPassword();
    const previousHeader = auth.getOpenCodeAuthHeaders().Authorization;
    const password = await auth.ensureLocalOpenCodeServerPassword({ rotateManaged: true });
    const accepts = (header) => header === `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    expect(password !== old).toBe(true);
    expect(accepts(previousHeader)).toBe(false);
    expect(accepts(auth.getOpenCodeAuthHeaders().Authorization)).toBe(true);
    expect(restore().openCodeAuthPassword === password).toBe(true);
  });

  it('adopts only shared registration credentials and never falls back to private env after clearing', () => {
    const { auth, processLike, restore } = setup({ OPENCODE_PASSWORD: 'private-fixture', OPENCODE_SERVER_USERNAME: 'private-user' });
    auth.adoptOpenCodeServerPassword('registration-fixture', 'shared-service');
    expect(auth.getOpenCodeAuthHeaders().Authorization === `Basic ${Buffer.from('opencode:registration-fixture').toString('base64')}`).toBe(true);
    auth.adoptOpenCodeServerPassword(null, 'shared-service');
    expect(restore().openCodeAuthPassword).toBeNull();
    expect(restore().openCodeAuthSource).toBe('shared-service');
    auth.adoptOpenCodeServerPassword(null, null);
    processLike.env.OPENCODE_SERVER_PASSWORD = 'stale-fixture';
    expect(auth.getOpenCodeAuthHeaders()).toEqual({});
  });
});
