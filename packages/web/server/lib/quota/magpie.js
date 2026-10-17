import { createHash } from 'node:crypto';
import { readOpenCodeCredentials, readOpenCodeProviderConfigs } from '../opencode/auth.js';
import { discoverLocalMagpie } from './magpie-local.js';

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' ? v : '';
const hash = (v) => createHash('sha256').update(v).digest('hex').slice(0, 20);
const time = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const percent = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;

export function magpieBaseURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid Magpie URL');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
  return url.href.replace(/\/$/, '');
}

const emptyWindow = () => ({ usedPercent: null, remainingPercent: null, windowSeconds: null,
  resetAfterSeconds: null, resetAt: null, resetAtFormatted: null, resetAfterFormatted: null });

export function projectMagpieQuotas(payload, source, now = Date.now()) {
  if (!record(payload) || payload.object !== 'list' || !Array.isArray(payload.data)) throw new Error('Invalid Magpie quota response');
  const providers = new Map();
  for (const q of payload.data) {
    if (!record(q) || !text(q.provider) || !Array.isArray(q.windows)) throw new Error('Invalid Magpie quota response');
    const id = `magpie:${source.id}:${encodeURIComponent(q.provider)}`;
    let result = providers.get(id);
    if (!result) {
      result = { providerId: id, providerName: `${text(q.name) || q.provider} · Magpie${source.name.toLowerCase() === 'magpie' ? '' : ` (${source.name})`}`,
        sourceId: source.id, source: 'magpie', upstreamProviderId: q.provider,
        ok: true, configured: true, fetchedAt: now, usage: { windows: {}, accounts: [] } };
      providers.set(id, result);
    }
    const account = { id: hash(JSON.stringify([q.kind, q.user, q.from, q.seat])),
      name: text(q.alias) || text(q.user) || text(q.plan) || text(q.name) || q.provider,
      user: text(q.user), plan: text(q.plan), kind: text(q.kind), from: text(q.from),
      balance: text(q.balance), error: q.error ? 'Magpie could not read this account’s quota' : undefined,
      readAt: time(q.readAt) ?? time(q.asOf), stale: Boolean(q.asOf || q.readDeferred), windows: {} };
    for (const [i, w] of q.windows.entries()) {
      if (!record(w) || typeof w.name !== 'string') throw new Error('Invalid Magpie quota window');
      const resetAt = time(w.resetsAt);
      const window = { ...emptyWindow(),
        usedPercent: w.unlimited ? null : percent(w.used), remainingPercent: w.unlimited ? null : percent(w.remaining),
        resetAt, resetAfterSeconds: resetAt === null ? null : Math.max(0, Math.ceil((resetAt - now) / 1000)),
        valueLabel: w.unlimited ? '∞' : text(w.display) || (Number.isFinite(w.amount) && Number.isFinite(w.limit) && w.limit > 0 ? `${w.amount} / ${w.limit}${text(w.unit) ? ` ${w.unit}` : ''}` : null),
        label: w.name, disablePace: true,
      };
      account.windows[`${i}:${w.name}`] = window;
      const label = `${account.name} · ${w.name}`;
      const key = Object.hasOwn(result.usage.windows, label) ? `${label} (${result.usage.accounts.length + 1}.${i + 1})` : label;
      result.usage.windows[key] = window;
    }
    if (account.balance) {
      const window = { ...emptyWindow(), valueLabel: account.balance, label: 'credits_balance', disablePace: true };
      account.windows.balance = window;
      result.usage.windows[`${account.name} · ${q.kind} (${result.usage.accounts.length + 1})`] = window;
    }
    if (account.error) {
      result.ok = false;
      result.error = 'Some Magpie accounts could not be refreshed';
    }
    result.usage.accounts.push(account);
  }
  return [...providers.values()];
}

async function getJSON(fetchImpl, url, headers, timeout, signal) {
  const response = await fetchImpl(url, { headers, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'Magpie quota access denied (check gateway key permissions)' : `Magpie request failed (HTTP ${response.status})`);
  return response.json();
}

/** One aggregate request per distinct URL/credential scope, at most four in flight. No persistent credential cache. */
export async function fetchMagpieQuotas({ directory, manualURL = '', refresh = false, signal,
  loadProviders = readOpenCodeProviderConfigs, loadCredentials = readOpenCodeCredentials,
  discoverLocal = discoverLocalMagpie, fetchImpl = fetch } = {}) {
  const [connections, local] = await Promise.all([
    Promise.all([loadProviders(directory), loadCredentials()]).catch(() => null),
    discoverLocal().catch(() => ({ urls: [], incomplete: true })),
  ]);
  const [providers, credentials] = connections ?? [{}, {}];
  const candidates = [];
  for (const [id, p] of Object.entries(providers)) {
    const raw = p.settings?.baseURL;
    if (!text(raw)) continue;
    let baseURL;
    try { baseURL = magpieBaseURL(raw); } catch { continue; }
    const headers = { Accept: 'application/json' };
    for (const [name, value] of Object.entries(p.headers || {})) {
      if (typeof value === 'string' && ['authorization', 'x-api-key'].includes(name.toLowerCase())) headers[name] = value;
    }
    const key = credentials[id]?.type === 'api' ? credentials[id].key : text(p.settings?.apiKey);
    if (key && !Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${key}`;
    candidates.push({ id: hash(`${baseURL}\n${id}`), name: text(p.name) || id, baseURL, headers, explicit: /magpie/i.test(id) || /magpie/i.test(text(p.name)) });
  }
  if (manualURL) {
    const baseURL = magpieBaseURL(manualURL);
    candidates.push({ id: hash(`${baseURL}\nmanual`), name: 'Magpie', baseURL, explicit: true,
      headers: { Accept: 'application/json', ...(process.env.OPENCHAMBER_MAGPIE_API_KEY ? { Authorization: `Bearer ${process.env.OPENCHAMBER_MAGPIE_API_KEY}` } : {}) } });
  }
  for (const url of local.urls) {
    let baseURL;
    try { baseURL = magpieBaseURL(url); } catch { continue; }
    if (candidates.some((candidate) => candidate.baseURL === baseURL)) continue;
    candidates.push({ id: hash(`${baseURL}\nlocal`), name: 'Magpie', baseURL,
      headers: { Accept: 'application/json' }, explicit: false, local: true });
  }
  const seen = new Set();
  const unique = candidates.filter((s) => {
    const key = JSON.stringify([s.baseURL, Object.entries(s.headers).sort()]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const sources = new Array(unique.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (cursor < unique.length) {
      const index = cursor++;
      const source = unique[index];
      let identified = false;
      try {
        const info = await getJSON(fetchImpl, source.baseURL, source.headers, 2500, signal);
        identified = info?.name === 'magpie' && Array.isArray(info.apis) && info.apis.includes('/v1/magpie/quotas');
        if (!identified) {
          if (source.explicit) throw new Error('The endpoint did not identify itself as Magpie with quota support');
          sources[index] = { id: source.id, name: source.name, results: [], ignored: true }; continue;
        }
        let payload;
        let refreshError;
        try {
          payload = await getJSON(fetchImpl, `${source.baseURL}/magpie/quotas${refresh ? '' : '?kept=1'}`, source.headers, refresh ? 15000 : 5000, signal);
        } catch (error) {
          if (!refresh || signal?.aborted || /access denied/.test(error.message)) throw error;
          payload = await getJSON(fetchImpl, `${source.baseURL}/magpie/quotas?kept=1`, source.headers, 5000, signal);
          refreshError = 'Magpie refresh failed; showing its last reading';
        }
        const results = projectMagpieQuotas(payload, source);
        if (refreshError) for (const result of results) {
          result.ok = false; result.error = refreshError;
          for (const account of result.usage.accounts) account.stale = true;
        }
        sources[index] = { id: source.id, name: source.name, results, identified: true, ...(refreshError ? { error: refreshError } : {}) };
      } catch (error) {
        // Do not forward upstream response bodies, URLs, account errors or credentials.
        const known = error instanceof Error && /^(Magpie |Invalid Magpie |The endpoint)/.test(error.message);
        sources[index] = { id: source.id, name: source.name, results: [],
          error: known ? error.message : identified || source.explicit ? 'Magpie is unavailable' : 'Provider identity could not be checked',
          clearPrevious: known && /access denied/.test(error.message),
          identified: identified || source.explicit };
      }
    }
  }));
  return { sources, incomplete: !connections || local.incomplete };
}
