import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertServerOpenCodeExecutionAllowed,
  configureServerOpenCodeFetchGate,
  createServerOpenCodeFetch,
  resolveFetchMethodAndPath,
  wrapFetchWithRuntimeContractGate,
} from './server-opencode-fetch.js';
import { makeOpenCodeV2Client } from './v2-client.js';

describe('serverOpenCodeFetch transport gate (ticket 11)', () => {
  afterEach(() => {
    configureServerOpenCodeFetchGate(null);
  });

  it('resolves method and path from URL strings', () => {
    expect(resolveFetchMethodAndPath('http://127.0.0.1:4096/session/ses_1/prompt', { method: 'POST' }))
      .toEqual({ method: 'POST', pathWithQuery: '/session/ses_1/prompt' });
  });

  it('blocks write execution when contract denies, keeps reads and stop-task', () => {
    const contract = {
      executionAllowed: false,
      phase: 'ready-unverified',
      reasons: ['unverified-newer'],
      serveVersion: '2.1.0',
      minVerifiedVersion: '2.0.12',
      maxVerifiedVersion: '2.0.14',
    };

    expect(assertServerOpenCodeExecutionAllowed({
      getRuntimeContract: () => contract,
      method: 'POST',
      pathWithQuery: '/session/ses_1/prompt_async',
    })?.errorCode).toBe('RUNTIME_CONTRACT_EXECUTION_BLOCKED');

    expect(assertServerOpenCodeExecutionAllowed({
      getRuntimeContract: () => contract,
      method: 'GET',
      pathWithQuery: '/session/ses_1/message',
    })).toBeNull();

    expect(assertServerOpenCodeExecutionAllowed({
      getRuntimeContract: () => contract,
      method: 'POST',
      pathWithQuery: '/session/ses_1/interrupt',
    })).toBeNull();
  });

  it('production default blocks Host writes when contract is missing', () => {
    expect(assertServerOpenCodeExecutionAllowed({
      getRuntimeContract: () => null,
      method: 'POST',
      pathWithQuery: '/session/ses_1/prompt',
    })?.errorCode).toBe('RUNTIME_CONTRACT_EXECUTION_BLOCKED');

    expect(assertServerOpenCodeExecutionAllowed({
      getRuntimeContract: () => null,
      method: 'POST',
      pathWithQuery: '/session/ses_1/prompt',
      allowMissingContract: true,
    })).toBeNull();
  });

  it('wrapFetch returns 409 JSON without calling upstream on blocked writes', async () => {
    const upstream = vi.fn(async () => new Response('ok'));
    configureServerOpenCodeFetchGate(() => ({
      executionAllowed: false,
      phase: 'incompatible',
      reasons: ['below-min-verified'],
      serveVersion: '2.0.5',
      minVerifiedVersion: '2.0.12',
    }));
    const gated = wrapFetchWithRuntimeContractGate(upstream);
    const response = await gated('http://opencode.test/session/ses_1/prompt', { method: 'POST', body: '{}' });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.errorCode).toBe('RUNTIME_CONTRACT_EXECUTION_BLOCKED');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('createServerOpenCodeFetch throws structured error on blocked prompt', async () => {
    const fetchImpl = vi.fn();
    const serverOpenCodeFetch = createServerOpenCodeFetch({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getRuntimeContract: () => ({
        executionAllowed: false,
        phase: 'ready-unverified',
        reasons: ['unverified-newer'],
        serveVersion: '2.1.0',
      }),
      fetchImpl,
    });

    await expect(serverOpenCodeFetch('/session/ses_1/prompt_async', {
      method: 'POST',
      body: { parts: [] },
    })).rejects.toMatchObject({
      code: 'RUNTIME_CONTRACT_EXECUTION_BLOCKED',
      status: 409,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('makeOpenCodeV2Client uses gated fetch so host SDK cannot bypass admission', async () => {
    const upstream = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    configureServerOpenCodeFetchGate(() => ({
      executionAllowed: false,
      phase: 'incompatible',
      reasons: ['below-min-verified'],
      serveVersion: '2.0.1',
    }));

    // Client construction must not throw; gate applies on network.
    const client = makeOpenCodeV2Client({
      baseUrl: 'http://opencode.test',
      fetchImpl: upstream,
    });
    expect(client).toBeTruthy();

    const gated = wrapFetchWithRuntimeContractGate(upstream);
    const blocked = await gated('http://opencode.test/session', { method: 'POST', body: '{}' });
    expect(blocked.status).toBe(409);
    expect(upstream).not.toHaveBeenCalled();
  });
});
