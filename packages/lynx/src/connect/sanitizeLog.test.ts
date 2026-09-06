import { describe, expect, test } from 'vitest';

import { sanitizeLogDetail } from './sanitizeLog.ts';

describe('sanitizeLogDetail', () => {
  test('never forwards tokens, pairing secrets, passwords, or grants', () => {
    expect(sanitizeLogDetail({
      hasToken: true,
      clientToken: 'oc_live_secret',
      secret: 'one-time',
      password: 'hunter2',
      grant: 'relay-grant',
      Authorization: 'Bearer abc',
      status: 200,
    })).toEqual({
      hasToken: true,
      clientToken: '[redacted]',
      secret: '[redacted]',
      password: '[redacted]',
      grant: '[redacted]',
      Authorization: '[redacted]',
      status: 200,
    });
  });
});
