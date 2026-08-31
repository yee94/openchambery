import { expect, it } from 'bun:test';
import crypto from 'node:crypto';

import { createApnsProvider, DEAD_TOKEN_REASONS } from '../src/push/apns.js';

const p8 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const mockHttp2 = (handler) => {
  const sessions = [];
  return {
    sessions,
    connect(url) {
      const client = {
        url,
        closed: false,
        handlers: {},
        on(event, cb) { this.handlers[event] = cb; return this; },
        close() { this.closed = true; this.handlers.close?.(); },
        request(headers) {
          const listeners = {};
          const req = {
            headers,
            on(event, cb) { listeners[event] = cb; return req; },
            setEncoding() { return req; },
            close() { listeners.error?.(new Error('closed')); },
            end(body) { handler({ headers, body, listeners, client }); },
          };
          return req;
        },
      };
      sessions.push(client);
      return client;
    },
  };
};

const respond = (listeners, status, body = '') => {
  queueMicrotask(() => {
    listeners.response?.({ ':status': String(status) });
    if (body) listeners.data?.(body);
    listeners.end?.();
  });
};

it('reuses one http2 session per environment, caches JWT for 50 minutes, and retries ExpiredProviderToken once', async () => {
  let now = 1_000_000;
  const calls = [];
  const http2 = mockHttp2(({ headers, listeners }) => {
    calls.push(headers);
    if (calls.length === 1) respond(listeners, 403, JSON.stringify({ reason: 'ExpiredProviderToken' }));
    else respond(listeners, 200);
  });
  const provider = createApnsProvider({
    keyId: 'KEYID12345', teamId: 'TEAMID1234', p8, bundleId: 'com.openchamber.app',
    http2, clock: { now: () => now, setTimeout, clearTimeout },
  });
  const payload = { aps: { alert: { title: 't' } } };
  expect(await provider.send({ token: 'a'.repeat(64), env: 'sandbox', payload })).toEqual({ ok: true, drop: undefined });
  expect(http2.sessions).toHaveLength(1);
  expect(calls).toHaveLength(2);
  expect(calls[0].authorization).not.toBe(calls[1].authorization);
  expect(calls[0]['apns-topic']).toBe('com.openchamber.app');
  const firstJwt = calls[1].authorization;
  now += 49 * 60 * 1000;
  expect(await provider.send({ token: 'b'.repeat(64), env: 'sandbox', payload })).toMatchObject({ ok: true });
  expect(http2.sessions).toHaveLength(1);
  expect(calls[2].authorization).toBe(firstJwt);
  now += 2 * 60 * 1000;
  expect(await provider.send({ token: 'c'.repeat(64), env: 'production', payload })).toMatchObject({ ok: true });
  expect(http2.sessions).toHaveLength(2);
  expect(calls[3].authorization).not.toBe(firstJwt);
  provider.close();
});

it('returns drop for dead tokens and 410, but not for 429 or transport failure', async () => {
  const sequence = [
    { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) },
    { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) },
    { status: 429, body: JSON.stringify({ reason: 'TooManyRequests' }) },
    { error: true },
  ];
  const http2 = mockHttp2(({ listeners }) => {
    const next = sequence.shift();
    if (next.error) {
      queueMicrotask(() => listeners.error(new Error('reset')));
      return;
    }
    respond(listeners, next.status, next.body);
  });
  const provider = createApnsProvider({ keyId: 'KEYID12345', teamId: 'TEAMID1234', p8, bundleId: 'com.openchamber.app', http2 });
  const payload = { aps: { alert: { title: 't' } } };
  expect(await provider.send({ token: 'a'.repeat(64), env: 'sandbox', payload })).toEqual({ ok: false, drop: true });
  expect(await provider.send({ token: 'b'.repeat(64), env: 'sandbox', payload })).toEqual({ ok: false, drop: true });
  expect(await provider.send({ token: 'c'.repeat(64), env: 'sandbox', payload })).toEqual({ ok: false, drop: undefined });
  expect(await provider.send({ token: 'd'.repeat(64), env: 'sandbox', payload })).toEqual({ ok: false, drop: undefined });
  expect(DEAD_TOKEN_REASONS.has('DeviceTokenNotForTopic')).toBe(true);
  provider.close();
});
