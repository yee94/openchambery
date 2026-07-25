import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const DEFAULT_GROK_CLI_PROXY_ORIGIN = 'https://cli-chat-proxy.grok.com';
const DEFAULT_GROK_CLIENT_VERSION = '1.0.0';

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

/**
 * Convert Grok Build billing credits payload into usage windows.
 * Accepts body.config or body directly.
 */
export const buildXaiUsageWindows = (body) => {
  const config =
    body?.config && typeof body.config === 'object' ? body.config : body;
  if (!config || typeof config !== 'object') {
    return null;
  }

  const creditUsagePercent = toNumber(
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

  let usedPercent = null;
  if (creditUsagePercent != null) {
    usedPercent = clampPercent(creditUsagePercent);
  } else if (
    monthlyLimitCents != null &&
    monthlyLimitCents > 0 &&
    usedCents != null
  ) {
    usedPercent = clampPercent((Math.max(0, usedCents) / monthlyLimitCents) * 100);
  } else if (prepaidCents != null && prepaidCents > 0) {
    // Prepaid-only: no usage percent; surface balance via valueLabel.
    usedPercent = null;
  } else {
    return null;
  }

  const startTs = toTimestamp(periodStart);
  const endTs = toTimestamp(periodEnd);
  const windowSeconds =
    startTs != null && endTs != null
      ? Math.max(0, Math.round((endTs - startTs) / 1000))
      : null;

  let windowKey;
  if (windowSeconds != null && windowSeconds > 0) {
    windowKey = resolveWindowLabel(windowSeconds);
  } else if (periodType) {
    const normalized = periodType.toLowerCase();
    if (normalized.includes('week')) windowKey = 'weekly';
    else if (normalized.includes('month')) windowKey = 'monthly';
    else if (normalized.includes('day')) windowKey = 'daily';
    else windowKey = periodType;
  } else {
    windowKey = 'credits';
  }

  const prepaidUsd =
    prepaidCents == null ? null : Math.max(0, prepaidCents) / 100;
  const valueLabel =
    usedPercent == null && prepaidUsd != null
      ? `$${formatMoney(prepaidUsd)} prepaid`
      : null;

  const windows = {};
  windows[windowKey] = toUsageWindow({
    usedPercent,
    windowSeconds: windowSeconds && windowSeconds > 0 ? windowSeconds : null,
    resetAt: endTs,
    valueLabel
  });

  return windows;
};

export const fetchQuota = async (options = {}) => {
  const authPath = options.authPath ?? resolveGrokAuthPath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const grokAuth = readGrokBuildAuth(authPath);

  if (!grokAuth?.key || !grokAuth?.userId) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured — run `grok login` (Grok Build CLI)'
    });
  }

  const origin = resolveGrokCliProxyOrigin();
  const creditsUrl = `${origin}/v1/billing?format=credits`;

  try {
    const response = await fetchImpl(creditsUrl, {
      method: 'GET',
      headers: buildGrokCliHeaders(grokAuth),
      signal: AbortSignal.timeout(15_000)
    });

    if (response.status === 401 || response.status === 403) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error:
          'Grok access token was rejected — start Grok once to refresh access, then retry'
      });
    }

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const body = await response.json();
    const windows = buildXaiUsageWindows(body);
    if (!windows || Object.keys(windows).length === 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
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
