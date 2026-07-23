import { describe, expect, it, vi } from 'vitest';

import {
  createDirectoryInstanceRecovery,
  extractDirectoryFromRequest,
  isDirectoryInstanceUnhealthyStatus,
  isDirectoryTurnAdmissionPath,
} from './instance-recovery-runtime.js';

describe('isDirectoryTurnAdmissionPath', () => {
  it('matches prompt_async, command, and shell admissions', () => {
    expect(isDirectoryTurnAdmissionPath('/session/ses_1/prompt_async')).toBe(true);
    expect(isDirectoryTurnAdmissionPath('/session/ses_1/prompt_async?directory=/x')).toBe(true);
    expect(isDirectoryTurnAdmissionPath('/session/ses_1/command')).toBe(true);
    expect(isDirectoryTurnAdmissionPath('/session/ses_1/shell')).toBe(true);
  });

  it('rejects unrelated paths', () => {
    expect(isDirectoryTurnAdmissionPath('/session/ses_1/message')).toBe(false);
    expect(isDirectoryTurnAdmissionPath('/session')).toBe(false);
    expect(isDirectoryTurnAdmissionPath('/mcp')).toBe(false);
    expect(isDirectoryTurnAdmissionPath('')).toBe(false);
  });
});

describe('extractDirectoryFromRequest', () => {
  it('prefers the directory query param', () => {
    expect(extractDirectoryFromRequest({
      query: { directory: '/proj' },
      headers: { 'x-opencode-directory': '/other' },
    })).toBe('/proj');
  });

  it('falls back to x-opencode-directory and decodes uri-marked values', () => {
    expect(extractDirectoryFromRequest({
      query: {},
      headers: {
        'x-opencode-directory': encodeURIComponent('/Users/me/My Project'),
        'x-opencode-directory-encoding': 'uri',
      },
    })).toBe('/Users/me/My Project');
  });
});

describe('createDirectoryInstanceRecovery', () => {
  it('no-ops when the MCP probe is healthy', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const recovery = createDirectoryInstanceRecovery({
      buildOpenCodeUrl: (path) => `http://oc.local${path}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic x' }),
      fetchImpl,
    });

    await expect(recovery.ensureHealthy('/proj')).resolves.toEqual({
      recovered: false,
      reason: 'healthy',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/mcp?directory=');
  });

  it('disposes the directory instance after an MCP 503 probe', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/mcp?')) return { ok: false, status: 503 };
      if (String(url).includes('/instance/dispose')) return { ok: true, status: 200 };
      return { ok: false, status: 500 };
    });
    const warn = vi.fn();
    const recovery = createDirectoryInstanceRecovery({
      buildOpenCodeUrl: (path) => `http://oc.local${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      log: { warn },
      now: () => 1_000_000,
    });

    await expect(recovery.ensureHealthy('/Users/me/agent-tracker')).resolves.toEqual({
      recovered: true,
      reason: 'disposed-after-mcp-503',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toContain('/instance/dispose?directory=');
    expect(warn).toHaveBeenCalled();
  });

  it('coalesces concurrent recovery for the same directory', async () => {
    let releaseProbe;
    const probeGate = new Promise((resolve) => {
      releaseProbe = resolve;
    });
    let probes = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/mcp?')) {
        probes += 1;
        await probeGate;
        return { ok: false, status: 503 };
      }
      return { ok: true, status: 200 };
    });
    const recovery = createDirectoryInstanceRecovery({
      buildOpenCodeUrl: (path) => `http://oc.local${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      now: () => 50,
    });

    const first = recovery.ensureHealthy('/proj');
    const second = recovery.ensureHealthy('/proj');
    releaseProbe();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { recovered: true, reason: 'disposed-after-mcp-503' },
      { recovered: true, reason: 'disposed-after-mcp-503' },
    ]);
    expect(probes).toBe(1);
  });

  it('respects dispose cooldown to avoid thrashing', async () => {
    let now = 1000;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/mcp?')) return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    });
    const recovery = createDirectoryInstanceRecovery({
      buildOpenCodeUrl: (path) => `http://oc.local${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      now: () => now,
      minDisposeIntervalMs: 10_000,
    });

    await expect(recovery.ensureHealthy('/proj')).resolves.toMatchObject({ recovered: true });
    now = 2000;
    await expect(recovery.ensureHealthy('/proj')).resolves.toEqual({
      recovered: false,
      reason: 'dispose-cooldown',
    });
    expect(fetchImpl.mock.calls.filter((call) => String(call[0]).includes('/instance/dispose'))).toHaveLength(1);
  });
});

describe('isDirectoryInstanceUnhealthyStatus', () => {
  it('treats only 503 as the poisoned-instance signal', () => {
    expect(isDirectoryInstanceUnhealthyStatus(503)).toBe(true);
    expect(isDirectoryInstanceUnhealthyStatus(500)).toBe(false);
    expect(isDirectoryInstanceUnhealthyStatus(200)).toBe(false);
  });
});
