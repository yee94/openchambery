/** Credential list/create replies contain raw keys in v2. Keep them host-only. */
export function isSensitiveCredentialResponse(method, requestPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestPath, 'http://openchamber.invalid').pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return true;
  }
  const root = pathname === '/credential' || pathname === '/api/credential';
  return root && ['GET', 'HEAD', 'POST'].includes(String(method).toUpperCase());
}
