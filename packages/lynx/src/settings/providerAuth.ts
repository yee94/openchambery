/**
 * Cap ProvidersPage auth flows over OpenCode HTTP (runtimeFetch).
 * API key + OAuth authorize/callback use clear Cap routes. Host must open
 * authorize URLs (ASWebAuthenticationSession / Custom Tabs) — Lynx does not
 * invent browser OAuth or Capgo.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';

export type LynxProviderAuthMethod = {
  type: string;
  label: string;
  index: number;
};

export type LynxProviderAuthMethodsResult =
  | { status: 'ok'; byProvider: Record<string, LynxProviderAuthMethod[]> }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxProviderAuthMutationResult =
  | { status: 'ok' }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxOAuthAuthorizeResult =
  | {
      status: 'ok';
      url?: string;
      instructions?: string;
      userCode?: string;
      mode: 'auto' | 'code';
      /** Host-only: open this URL in a system browser / auth session. */
      hostOnlySteps: string[];
    }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

const str = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const normalizeAuthType = (method: Record<string, unknown>): string => {
  const raw = str(method.type) || str(method.kind) || str(method.auth) || '';
  return raw.toLowerCase();
};

const HOST_ONLY_OAUTH_STEPS = [
  'Host opens authorize URL via system browser / ASWebAuthenticationSession (iOS) or Custom Tabs (Android).',
  'Host returns control to Lynx with optional user code; Lynx POSTs Cap oauth/callback.',
  'Do not invent Capgo or in-WebView OAuth redirects.',
] as const;

/** Cap SDK `provider.auth()` → `GET /api/provider/auth`. */
export const loadLynxProviderAuthMethods = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxProviderAuthMethodsResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch('/api/provider/auth', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`provider/auth failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = await response.json();
    const root = asRecord(payload);
    const source = asRecord(root.data).providers
      ? asRecord(root.data)
      : root;
    const providers = asRecord(source.providers ?? source);
    const byProvider: Record<string, LynxProviderAuthMethod[]> = {};
    for (const [providerId, rawMethods] of Object.entries(providers)) {
      const list = Array.isArray(rawMethods)
        ? rawMethods
        : Array.isArray(asRecord(rawMethods).methods)
          ? (asRecord(rawMethods).methods as unknown[])
          : null;
      if (!list) continue;
      byProvider[providerId] = list.flatMap((method, index) => {
        if (!method || typeof method !== 'object') return [];
        const record = method as Record<string, unknown>;
        const type = normalizeAuthType(record) || 'unknown';
        const label = str(record.label) || str(record.name) || type;
        return [{ type, label, index }];
      });
    }
    // Cap sometimes returns a flat map providerID → AuthMethod[].
    if (Object.keys(byProvider).length === 0 && Array.isArray(payload)) {
      return {
        status: 'failed',
        error: new Error('provider/auth returned unexpected array shape'),
      };
    }
    return { status: 'ok', byProvider };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap SDK `auth.set` → `PUT /api/auth/:providerID` with `{ type:'api', key }`. */
export const saveLynxProviderApiKey = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  providerId: string,
  apiKey: string,
  options?: { signal?: AbortSignal },
): Promise<LynxProviderAuthMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = providerId.trim();
  const key = apiKey.trim();
  if (!id) return { status: 'failed', error: new Error('provider id required') };
  if (!key) return { status: 'failed', error: new Error('api key required') };
  try {
    const response = await runtimeFetch(`/api/auth/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'api', key }),
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`auth.set failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap SDK `provider.oauth.authorize` → `POST /api/provider/:id/oauth/authorize`. */
export const startLynxProviderOAuth = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  providerId: string,
  methodIndex: number,
  options?: { signal?: AbortSignal },
): Promise<LynxOAuthAuthorizeResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = providerId.trim();
  if (!id) return { status: 'failed', error: new Error('provider id required') };
  try {
    const response = await runtimeFetch(
      `/api/provider/${encodeURIComponent(id)}/oauth/authorize`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ method: methodIndex }),
        signal: options?.signal,
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`oauth/authorize failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    const payload = asRecord(await response.json());
    const nested = asRecord(payload.data);
    const data = Object.keys(nested).length > 0 ? nested : payload;
    const url = str(data.url)
      || str(data.verification_uri_complete)
      || str(data.verification_uri);
    const instructions = str(data.instructions) || str(data.message);
    const userCode = str(data.user_code) || str(data.code) || str(data.userCode);
    const mode = data.method === 'auto' ? 'auto' : 'code';
    if (!url && !instructions && !userCode) {
      return {
        status: 'failed',
        error: new Error('oauth/authorize returned no url/instructions/userCode'),
      };
    }
    return {
      status: 'ok',
      url,
      instructions,
      userCode,
      mode,
      hostOnlySteps: [...HOST_ONLY_OAUTH_STEPS],
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap SDK `provider.oauth.callback` → `POST /api/provider/:id/oauth/callback`. */
export const completeLynxProviderOAuth = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  providerId: string,
  methodIndex: number,
  code?: string,
  options?: { signal?: AbortSignal },
): Promise<LynxProviderAuthMutationResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const id = providerId.trim();
  if (!id) return { status: 'failed', error: new Error('provider id required') };
  try {
    const body: { method: number; code?: string } = { method: methodIndex };
    const trimmedCode = code?.trim();
    if (trimmedCode) body.code = trimmedCode;
    const response = await runtimeFetch(
      `/api/provider/${encodeURIComponent(id)}/oauth/callback`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      },
    );
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`oauth/callback failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

export const LYNX_PROVIDER_OAUTH_HOST_ONLY_STEPS = HOST_ONLY_OAUTH_STEPS;
