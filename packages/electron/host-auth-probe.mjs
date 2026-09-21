export const probeHostAuthentication = async (baseUrl, { headers, timeoutMs, fetchImpl = fetch }) => {
  try {
    const response = await fetchImpl(new URL('/auth/session', baseUrl).toString(), {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) return 'auth';
    if (!response.ok) return 'unreachable';
    const payload = await response.json().catch(() => null);
    return payload?.authenticated === true ? 'ok' : 'auth';
  } catch {
    return 'unreachable';
  }
};
