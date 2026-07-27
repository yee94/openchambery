import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  resolveWindowLabel,
  asNonEmptyString,
  formatMoney
} from '../utils/index.js';

export const providerId = 'xai';
export const providerName = 'Grok';
export const aliases = ['xai', 'grok', 'x-ai'];

const execFileAsync = promisify(execFile);

const DEFAULT_GROK_CLI_PROXY_ORIGIN = 'https://cli-chat-proxy.grok.com';
const DEFAULT_GROK_CLIENT_VERSION = '1.0.0';
const GROK_AUTH_RENEWAL_PROMPT = 'Reply with OK.';
const GROK_AUTH_RENEWAL_TIMEOUT_MS = 120_000;

let grokAuthRenewalPromise = null;

const firstNonEmptyString = (...values) => {
  for (const value of values) {
    const resolved = asNonEmptyString(value);
    if (resolved) return resolved;
  }
  return null;
};

export const resolveGrokAuthPath = () => {
  return (
    firstNonEmptyString(
      process.env.OPENCHAMBER_GROK_AUTH_PATH,
      process.env.GROK_AUTH_PATH
    ) ||
    path.join(
      firstNonEmptyString(process.env.GROK_HOME) || path.join(os.homedir(), '.grok'),
      'auth.json'
    )
  );
};

const isExpired = (expiresAt, now = Date.now()) => {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return false;
  return ts <= now;
};

const parseCents = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  if (value && typeof value === 'object' && value.val != null) {
    return parseCents(value.val);
  }
  // proto3 JSON may omit zero-valued Cent as {}
  if (value && typeof value === 'object' && Object.keys(value).length === 0) {
    return 0;
  }
  return null;
};

const clampPercent = (value) => Math.max(0, Math.min(100, value));

/**
 * Read Grok Build local credentials from ~/.grok/auth.json (or env overrides).
 * Shape: { "<issuer>::<client_id>": { key, user_id, team_id, email, expires_at, ... } }
 * Never returns or logs the secret key to callers outside fetchQuota internals.
 */
export const readGrokBuildAuth = (authPath = resolveGrokAuthPath()) => {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const entries = [];
  for (const [entryKey, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const key = firstNonEmptyString(value.key, value.access_token, value.accessToken);
    const userId = firstNonEmptyString(
      value.user_id,
      value.userId,
      value.principal_id,
      value.principalId
    );
    if (!key || !userId) continue;

    const expiresAt = firstNonEmptyString(value.expires_at, value.expiresAt);
    const createTime = firstNonEmptyString(value.create_time, value.createTime);
    entries.push({
      entryKey,
      key,
      userId,
      teamId: firstNonEmptyString(value.team_id, value.teamId),
      email: firstNonEmptyString(value.email),
      expiresAt,
      createTime
    });
  }

  if (entries.length === 0) {
    return null;
  }

  // Prefer non-expired, then newest create/expiry.
  const now = Date.now();
  entries.sort((a, b) => {
    const aExpired = isExpired(a.expiresAt, now);
    const bExpired = isExpired(b.expiresAt, now);
    if (aExpired !== bExpired) return aExpired ? 1 : -1;
    const ta = Date.parse(a.expiresAt || a.createTime || '') || 0;
    const tb = Date.parse(b.expiresAt || b.createTime || '') || 0;
    return tb - ta;
  });

  return {
    ...entries[0],
    authPath
  };
};

export const isConfigured = (authPath) => {
  const grokAuth = readGrokBuildAuth(authPath ?? resolveGrokAuthPath());
  return Boolean(grokAuth?.key && grokAuth?.userId);
};

const resolveGrokCliProxyOrigin = () =>
  firstNonEmptyString(process.env.OPENCHAMBER_GROK_CLI_PROXY_ORIGIN) ||
  DEFAULT_GROK_CLI_PROXY_ORIGIN;

export const resolveGrokCliPath = (environment = process.env) => {
  const homeDir = firstNonEmptyString(environment.HOME) || os.homedir();
  const pathCandidates = String(environment.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, 'grok'));
  const candidates = [
    environment.OPENCHAMBER_GROK_CLI_PATH,
    environment.AI_USAGE_TRACKER_GROK_CLI_PATH,
    environment.GROK_CLI_PATH,
    ...pathCandidates,
    path.join(homeDir, '.local', 'bin', 'grok'),
    path.join(homeDir, '.cargo', 'bin', 'grok'),
    '/opt/homebrew/bin/grok',
    '/usr/local/bin/grok'
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue searching
    }
  }
  return null;
};

const describeCommandError = (error) => {
  if (error?.killed && error?.signal === 'SIGTERM') {
    return 'command timed out';
  }
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  if (stderr) {
    return stderr.slice(0, 300);
  }
  return error instanceof Error ? error.message : String(error);
};

const runGrokBuildAuthRenewal = async ({
  authPath,
  execFileImpl = execFileAsync
}) => {
  const cliPath = resolveGrokCliPath();
  if (!cliPath) {
    return {
      ok: false,
      message: 'Grok Build CLI not found — install `grok` or set OPENCHAMBER_GROK_CLI_PATH'
    };
  }

  try {
    await execFileImpl(
      cliPath,
      [
        '-p',
        GROK_AUTH_RENEWAL_PROMPT,
        '--max-turns',
        '1',
        '--disable-web-search',
        '--no-subagents',
        '--no-memory'
      ],
      {
        cwd: os.homedir(),
        timeout: GROK_AUTH_RENEWAL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env
      }
    );
  } catch (error) {
    return {
      ok: false,
      message: `Grok Build CLI renewal failed: ${describeCommandError(error)}`
    };
  }

  const refreshedAuth = readGrokBuildAuth(authPath);
  if (!refreshedAuth?.key || !refreshedAuth?.userId || isExpired(refreshedAuth.expiresAt)) {
    return {
      ok: false,
      message: 'Grok Build CLI ran, but local access token is still expired'
    };
  }

  return {
    ok: true,
    expiresAt: refreshedAuth.expiresAt || null
  };
};

/**
 * Trigger Grok Build CLI once so it refreshes ~/.grok/auth.json access token.
 * Concurrent callers share a single in-flight renewal.
 */
export const renewGrokBuildAuth = async ({
  authPath = resolveGrokAuthPath(),
  execFileImpl = execFileAsync
} = {}) => {
  if (grokAuthRenewalPromise) {
    return grokAuthRenewalPromise;
  }

  grokAuthRenewalPromise = runGrokBuildAuthRenewal({ authPath, execFileImpl });
  try {
    return await grokAuthRenewalPromise;
  } finally {
    grokAuthRenewalPromise = null;
  }
};

const buildGrokCliHeaders = (grokAuth) => ({
  Authorization: `Bearer ${grokAuth.key}`,
  'x-xai-token-auth': 'xai-grok-cli',
  accept: 'application/json',
  'user-agent': 'OpenChamber/xai-quota',
  'x-userid': String(grokAuth.userId),
  'x-grok-client-version':
    firstNonEmptyString(process.env.OPENCHAMBER_GROK_CLIENT_VERSION) ||
    DEFAULT_GROK_CLIENT_VERSION
});

const isWeeklyGrokCreditsConfig = ({
  config,
  periodType,
  isUnifiedBillingUser,
  monthlyLimitCents
}) => {
  if (isUnifiedBillingUser) return true;
  if (periodType && /WEEKLY/i.test(String(periodType))) return true;
  const hasCurrentPeriod = Boolean(config?.currentPeriod || config?.current_period);
  if (hasCurrentPeriod && (monthlyLimitCents == null || monthlyLimitCents <= 0)) {
    return true;
  }
  return false;
};

const resolveGrokWindowKey = ({ windowSeconds, periodType, fallback = 'credits' }) => {
  if (windowSeconds != null && windowSeconds > 0) {
    return resolveWindowLabel(windowSeconds);
  }
  if (periodType) {
    const normalized = periodType.toLowerCase();
    if (normalized.includes('week')) return 'weekly';
    if (normalized.includes('month')) return 'monthly';
    if (normalized.includes('day')) return 'daily';
    return periodType;
  }
  return fallback;
};

/**
 * Convert Grok Build billing credits payload into usage windows.
 *
 * Official SuperGrok Usage page priority:
 *  1. Weekly SuperGrok Heavy — creditUsagePercent (proto3 may omit 0)
 *  2. Extra Usage Credits — prepaidBalance as credits_balance
 *  3. Legacy monthlyLimit/used only when weekly credits shape is absent
 */
export const buildXaiUsageWindows = (body) => {
  const config =
    body?.config && typeof body.config === 'object' ? body.config : body;
  if (!config || typeof config !== 'object') {
    return null;
  }

  let creditUsagePercent = toNumber(
    config.creditUsagePercent ?? config.credit_usage_percent
  );
  const prepaidCents = parseCents(config.prepaidBalance ?? config.prepaid_balance);
  const monthlyLimitCents = parseCents(config.monthlyLimit ?? config.monthly_limit);
  const usedCents = parseCents(config.used);
  const periodStart = firstNonEmptyString(
    config.currentPeriod?.start,
    config.current_period?.start,
    config.billingPeriodStart,
    config.billing_period_start
  );
  const periodEnd = firstNonEmptyString(
    config.currentPeriod?.end,
    config.current_period?.end,
    config.billingPeriodEnd,
    config.billing_period_end
  );
  const periodType = firstNonEmptyString(
    config.currentPeriod?.type,
    config.currentPeriod?.period_type,
    config.current_period?.type,
    config.current_period?.period_type
  );
  const isUnifiedBillingUser = Boolean(
    config.isUnifiedBillingUser ?? config.is_unified_billing_user
  );
  const isWeeklyCreditsShape = isWeeklyGrokCreditsConfig({
    config,
    periodType,
    isUnifiedBillingUser,
    monthlyLimitCents
  });

  // proto3 JSON omits default 0. Official UI still shows "0% used" for weekly Heavy.
  if (creditUsagePercent == null && isWeeklyCreditsShape) {
    creditUsagePercent = 0;
  }

  const prepaidUsd =
    prepaidCents == null ? null : Math.max(0, prepaidCents) / 100;
  const startTs = toTimestamp(periodStart);
  const endTs = toTimestamp(periodEnd);
  const windowSeconds =
    startTs != null && endTs != null
      ? Math.max(0, Math.round((endTs - startTs) / 1000))
      : null;

  const windows = {};

  // 1) Weekly SuperGrok Heavy always wins over monthly $ allotment.
  if (creditUsagePercent != null) {
    const windowKey = resolveGrokWindowKey({
      windowSeconds,
      periodType,
      fallback: 'weekly'
    });
    windows[windowKey] = toUsageWindow({
      usedPercent: clampPercent(creditUsagePercent),
      windowSeconds: windowSeconds && windowSeconds > 0 ? windowSeconds : null,
      resetAt: endTs
    });
  } else if (
    monthlyLimitCents != null &&
    monthlyLimitCents > 0 &&
    usedCents != null
  ) {
    // 3) Legacy monthly allotment — only when weekly percent is unavailable.
    const windowKey = resolveGrokWindowKey({
      windowSeconds,
      periodType,
      fallback: 'monthly'
    });
    windows[windowKey] = toUsageWindow({
      usedPercent: clampPercent((Math.max(0, usedCents) / monthlyLimitCents) * 100),
      windowSeconds: windowSeconds && windowSeconds > 0 ? windowSeconds : null,
      resetAt: endTs
    });
  }

  // 2) Extra Usage Credits (prepaid) — separate window when balance > 0,
  //    or as the sole window when no percent-based quota exists.
  if (prepaidUsd != null && prepaidUsd > 0) {
    windows.credits_balance = toUsageWindow({
      usedPercent: null,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `$${formatMoney(prepaidUsd)} prepaid`
    });
  } else if (Object.keys(windows).length === 0 && prepaidUsd != null) {
    // prepaid-only with $0 still surfaces a balance row so UI is not empty.
    windows.credits_balance = toUsageWindow({
      usedPercent: null,
      windowSeconds: null,
      resetAt: null,
      valueLabel: `$${formatMoney(prepaidUsd)} prepaid`
    });
  }

  if (Object.keys(windows).length === 0) {
    return null;
  }

  return windows;
};

const requestGrokCredits = async ({ fetchImpl, creditsUrl, grokAuth }) => {
  return fetchImpl(creditsUrl, {
    method: 'GET',
    headers: buildGrokCliHeaders(grokAuth),
    signal: AbortSignal.timeout(15_000)
  });
};

const buildRenewalFailureResult = (message) =>
  buildResult({
    providerId,
    providerName,
    ok: false,
    configured: true,
    error: `${message}. Run \`grok login\` if automatic renewal cannot recover access.`
  });

const mapCreditsResponse = async (response) => {
  if (response.status === 401 || response.status === 403) {
    return {
      kind: 'auth_failure',
      result: buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error:
          'Grok access token was rejected — start Grok once to refresh access, then retry'
      })
    };
  }

  if (!response.ok) {
    return {
      kind: 'error',
      result: buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      })
    };
  }

  const body = await response.json();
  const windows = buildXaiUsageWindows(body);
  if (!windows || Object.keys(windows).length === 0) {
    return {
      kind: 'error',
      result: buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      })
    };
  }

  return {
    kind: 'ok',
    result: buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    })
  };
};

export const fetchQuota = async (options = {}) => {
  const authPath = options.authPath ?? resolveGrokAuthPath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const renewGrokAuth = options.renewGrokAuth ?? renewGrokBuildAuth;

  let grokAuth = readGrokBuildAuth(authPath);
  if (!grokAuth?.key || !grokAuth?.userId) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured — run `grok login` (Grok Build CLI)'
    });
  }

  let renewalAttempted = false;
  if (isExpired(grokAuth.expiresAt)) {
    renewalAttempted = true;
    const renewal = await renewGrokAuth({ authPath });
    if (!renewal?.ok) {
      return buildRenewalFailureResult(
        renewal?.message || 'Grok Build CLI automatic renewal failed'
      );
    }
    grokAuth = readGrokBuildAuth(authPath);
    if (!grokAuth?.key || !grokAuth?.userId || isExpired(grokAuth.expiresAt)) {
      return buildRenewalFailureResult(
        'Grok Build CLI finished, but local access token is still expired'
      );
    }
  }

  const origin = resolveGrokCliProxyOrigin();
  // Official SuperGrok Usage is driven by format=credits (weekly + prepaid).
  // Default /v1/billing is a separate monthly allotment — last-resort only.
  const creditsUrl = `${origin}/v1/billing?format=credits`;
  const billingUrl = `${origin}/v1/billing`;

  try {
    let response = await requestGrokCredits({
      fetchImpl,
      creditsUrl,
      grokAuth
    });
    let mapped = await mapCreditsResponse(response);

    if (mapped.kind === 'auth_failure' && !renewalAttempted) {
      const renewal = await renewGrokAuth({ authPath });
      if (!renewal?.ok) {
        return buildRenewalFailureResult(
          renewal?.message || 'Grok Build CLI automatic renewal failed'
        );
      }

      const refreshedAuth = readGrokBuildAuth(authPath);
      if (
        !refreshedAuth?.key ||
        !refreshedAuth?.userId ||
        isExpired(refreshedAuth.expiresAt)
      ) {
        return buildRenewalFailureResult(
          'Grok Build CLI finished, but no valid access token was found'
        );
      }

      grokAuth = refreshedAuth;
      response = await requestGrokCredits({
        fetchImpl,
        creditsUrl,
        grokAuth
      });
      mapped = await mapCreditsResponse(response);
    }

    // Never replace a successful weekly credits result with monthly billing.
    if (mapped.kind === 'ok') {
      return mapped.result;
    }

    if (mapped.kind === 'auth_failure') {
      return mapped.result;
    }

    // Credits payload unusable: try legacy monthly billing once.
    const billingResponse = await requestGrokCredits({
      fetchImpl,
      creditsUrl: billingUrl,
      grokAuth
    });
    const billingMapped = await mapCreditsResponse(billingResponse);
    if (billingMapped.kind === 'ok') {
      return billingMapped.result;
    }

    return mapped.result;
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
