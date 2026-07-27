import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildXaiUsageWindows,
  fetchQuota,
  isConfigured,
  readGrokBuildAuth,
  resolveGrokCliPath
} from './xai.js';

const temporaryDirectories = [];

const makeAuthFile = (entries) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-xai-auth-'));
  temporaryDirectories.push(dir);
  const authPath = path.join(dir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify(entries), 'utf8');
  return authPath;
};

const writeAuth = (authPath, entry) => {
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      session: entry
    }),
    'utf8'
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.OPENCHAMBER_GROK_CLI_PROXY_ORIGIN;
  delete process.env.OPENCHAMBER_GROK_AUTH_PATH;
  delete process.env.GROK_AUTH_PATH;
  delete process.env.GROK_HOME;
  delete process.env.OPENCHAMBER_GROK_CLI_PATH;
  delete process.env.GROK_CLI_PATH;
});

describe('readGrokBuildAuth', () => {
  it('prefers non-expired newest entry and maps token field aliases', () => {
    const authPath = makeAuthFile({
      expired: {
        access_token: 'old-token',
        principal_id: 'user-old',
        expires_at: '2020-01-01T00:00:00.000Z',
        create_time: '2020-01-01T00:00:00.000Z'
      },
      current: {
        accessToken: 'new-token',
        principalId: 'user-new',
        team_id: 'team-1',
        email: 'user@example.com',
        expiresAt: '2099-01-01T00:00:00.000Z',
        createTime: '2024-06-01T00:00:00.000Z'
      }
    });

    const auth = readGrokBuildAuth(authPath);
    expect(auth).toMatchObject({
      key: 'new-token',
      userId: 'user-new',
      teamId: 'team-1',
      email: 'user@example.com',
      entryKey: 'current'
    });
    expect(isConfigured(authPath)).toBe(true);
  });

  it('returns null when auth file is missing', () => {
    expect(readGrokBuildAuth(path.join(os.tmpdir(), 'openchamber-xai-missing-auth.json'))).toBeNull();
    expect(isConfigured(path.join(os.tmpdir(), 'openchamber-xai-missing-auth.json'))).toBe(false);
  });
});

describe('resolveGrokCliPath', () => {
  it('resolves grok from ~/.local/bin when PATH has no match', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-xai-home-'));
    temporaryDirectories.push(homeDir);
    const binDir = path.join(homeDir, '.local', 'bin');
    const cliPath = path.join(binDir, 'grok');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(cliPath, '#!/bin/sh\n');
    fs.chmodSync(cliPath, 0o755);

    expect(
      resolveGrokCliPath({
        HOME: homeDir,
        PATH: '/usr/bin:/bin'
      })
    ).toBe(cliPath);
  });
});

describe('buildXaiUsageWindows', () => {
  it('maps creditUsagePercent with weekly period duration', () => {
    const start = '2026-07-18T00:00:00.000Z';
    const end = '2026-07-25T00:00:00.000Z';
    const windows = buildXaiUsageWindows({
      config: {
        creditUsagePercent: 42.5,
        prepaidBalance: { val: '1500' },
        currentPeriod: { start, end, type: 'WEEKLY' }
      }
    });

    expect(windows.weekly.usedPercent).toBe(42.5);
    expect(windows.weekly.remainingPercent).toBe(57.5);
    expect(windows.weekly.windowSeconds).toBe(7 * 86400);
    expect(windows.weekly.resetAt).toBe(Date.parse(end));
    expect(windows.weekly.valueLabel).toBeUndefined();
  });

  it('computes usedPercent from legacy monthlyLimit and used cents', () => {
    const windows = buildXaiUsageWindows({
      monthly_limit: { val: '10000' },
      used: { val: '2500' },
      billing_period_start: '2026-07-01T00:00:00.000Z',
      billing_period_end: '2026-08-01T00:00:00.000Z'
    });

    const key = Object.keys(windows)[0];
    expect(windows[key].usedPercent).toBe(25);
    expect(windows[key].remainingPercent).toBe(75);
    expect(windows[key].windowSeconds).toBe(31 * 86400);
  });

  it('uses a balance label only for prepaid-only usage', () => {
    const windows = buildXaiUsageWindows({
      prepaidBalance: { val: '1500' }
    });

    expect(windows.credits.usedPercent).toBeNull();
    expect(windows.credits.valueLabel).toBe('$15.00 prepaid');
  });
});

describe('fetchQuota', () => {
  it('returns configured false when auth is missing', async () => {
    const result = await fetchQuota({
      authPath: path.join(os.tmpdir(), 'openchamber-xai-no-auth.json')
    });
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.providerId).toBe('xai');
    expect(result.providerName).toBe('Grok');
  });

  it('sends Grok CLI headers and maps credits response', async () => {
    const authPath = makeAuthFile({
      session: {
        key: 'secret-token',
        user_id: 'uid-123',
        expires_at: '2099-01-01T00:00:00.000Z'
      }
    });
    process.env.OPENCHAMBER_GROK_CLI_PROXY_ORIGIN = 'https://proxy.test';

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        config: {
          credit_usage_percent: 10,
          current_period: {
            start: '2026-07-18T00:00:00.000Z',
            end: '2026-07-25T00:00:00.000Z'
          }
        }
      })
    });

    const result = await fetchQuota({ authPath, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.windows.weekly.usedPercent).toBe(10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://proxy.test/v1/billing?format=credits');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer secret-token',
      'x-xai-token-auth': 'xai-grok-cli',
      accept: 'application/json',
      'user-agent': 'OpenChamber/xai-quota',
      'x-userid': 'uid-123',
      'x-grok-client-version': '1.0.0'
    });
    // Never surface secret on result payload
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('renews expired local auth before requesting credits', async () => {
    const authPath = makeAuthFile({
      session: {
        key: 'expired-token',
        user_id: 'uid-expired',
        expires_at: '2020-01-01T00:00:00.000Z'
      }
    });

    let renewalCalls = 0;
    const renewGrokAuth = vi.fn(async () => {
      renewalCalls += 1;
      writeAuth(authPath, {
        key: 'renewed-token',
        user_id: 'uid-expired',
        expires_at: '2099-01-01T00:00:00.000Z'
      });
      return { ok: true };
    });

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        config: {
          creditUsagePercent: 12,
          currentPeriod: {
            start: '2026-07-18T00:00:00.000Z',
            end: '2026-07-25T00:00:00.000Z'
          }
        }
      })
    });

    const result = await fetchQuota({ authPath, fetchImpl, renewGrokAuth });

    expect(result.ok).toBe(true);
    expect(renewalCalls).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer renewed-token');
  });

  it('renews and retries once after 401', async () => {
    const authPath = makeAuthFile({
      session: {
        key: 'rejected-token',
        user_id: 'uid-401',
        expires_at: '2099-01-01T00:00:00.000Z'
      }
    });

    let requestCalls = 0;
    const renewGrokAuth = vi.fn(async () => {
      writeAuth(authPath, {
        key: 'renewed-token',
        user_id: 'uid-401',
        expires_at: '2099-01-01T00:00:00.000Z'
      });
      return { ok: true };
    });

    const fetchImpl = vi.fn(async (_url, init) => {
      requestCalls += 1;
      if (requestCalls === 1) {
        expect(init.headers.Authorization).toBe('Bearer rejected-token');
        return {
          ok: false,
          status: 401,
          json: async () => ({})
        };
      }
      expect(init.headers.Authorization).toBe('Bearer renewed-token');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          config: {
            creditUsagePercent: 8,
            currentPeriod: {
              start: '2026-07-18T00:00:00.000Z',
              end: '2026-07-25T00:00:00.000Z'
            }
          }
        })
      };
    });

    const result = await fetchQuota({ authPath, fetchImpl, renewGrokAuth });

    expect(result.ok).toBe(true);
    expect(renewGrokAuth).toHaveBeenCalledTimes(1);
    expect(requestCalls).toBe(2);
    expect(result.usage.windows.weekly.usedPercent).toBe(8);
  });

  it('returns renewal failure when automatic refresh cannot recover access', async () => {
    const authPath = makeAuthFile({
      session: {
        key: 'rejected-token',
        user_id: 'uid-401',
        expires_at: '2099-01-01T00:00:00.000Z'
      }
    });

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({})
    });

    const result = await fetchQuota({
      authPath,
      fetchImpl,
      renewGrokAuth: async () => ({
        ok: false,
        message: 'Grok Build CLI not found'
      })
    });

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toMatch(/Grok Build CLI not found/i);
    expect(result.error).toMatch(/grok login/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
