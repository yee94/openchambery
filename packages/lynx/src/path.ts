/** Lynx-owned path display normalizer. Do not import `@/lib/pathNormalization`. */
export const normalizePath = (value?: string | null): string =>
  // eslint-disable-next-line no-restricted-syntax -- Lynx cannot import the UI path helper.
  (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');
