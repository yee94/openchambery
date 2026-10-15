export function summaryErrorMessage(error, secrets = []) {
  let message = typeof error === 'string' ? error : error?.message;
  if (typeof message !== 'string' || !message.trim()) message = 'Model request failed';
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.trim()) message = message.split(secret).join('[REDACTED]');
  }
  return message
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|api[_-]?token|access[_-]?token|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .slice(0, 2000);
}
