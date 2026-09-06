const SECRET_KEY = /^(token|clienttoken|secret|password|authorization|grant|bearertoken|pairingsecret)$/i;
const SECRET_SUFFIX = /(token|secret|password|authorization|grant|bearer)$/i;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isSecretKey = (key: string): boolean => {
  if (key.toLowerCase() === 'hastoken') return false;
  return SECRET_KEY.test(key) || SECRET_SUFFIX.test(key);
};

const redactValue = (key: string, value: unknown): unknown => {
  if (isSecretKey(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((entry) => redactValue(key, entry));
  if (isPlainObject(value)) return sanitizeLogDetail(value);
  return value;
};

/** Strip bearer tokens, pairing secrets, passwords, and grants from log details. */
export const sanitizeLogDetail = (detail: Record<string, unknown> = {}): Record<string, unknown> => {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    next[key] = redactValue(key, value);
  }
  return next;
};

export const safeLogInfo = (
  logger: { info: (step: string, detail?: Record<string, unknown>) => void } | undefined,
  step: string,
  detail?: Record<string, unknown>,
): void => {
  logger?.info(step, detail ? sanitizeLogDetail(detail) : undefined);
};

export const safeLogWarn = (
  logger: { warn: (step: string, detail?: Record<string, unknown>) => void } | undefined,
  step: string,
  detail?: Record<string, unknown>,
): void => {
  logger?.warn(step, detail ? sanitizeLogDetail(detail) : undefined);
};
