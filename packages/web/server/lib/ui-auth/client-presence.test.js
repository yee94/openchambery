import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createClientPresence } from './client-presence.js';
import { createUiAuth } from './ui-auth.js';

const response = (type) => Object.assign(new EventEmitter(), { getHeader: () => type });
describe('live client presence', () => {
  it('tracks bearer-authenticated streams even on a password-free host', async () => {
    const auth = createUiAuth({ password: '', clientAuthController: {
      authenticateBearerToken: async () => ({ ok: true, clientId: 'phone' }),
    } });
    const res = response('text/event-stream');
    await auth.requireAuth({ res, method: 'GET', headers: { authorization: 'Bearer test-credential' }, url: '/api/event' }, res, () => {});
    expect([...auth.getConnectedClientIds()]).toEqual(['phone']);
    res.emit('close');
    expect([...auth.getConnectedClientIds()]).toEqual([]);
  });
  it('counts open streams, not ordinary requests, and preserves overlapping connections', () => {
    const presence = createClientPresence();
    const first = response('text/event-stream; charset=utf-8');
    const second = response('text/event-stream');
    presence.track({ res: response('application/json') }, { clientId: 'history-only' });
    presence.track({ res: first }, { clientId: 'phone' });
    presence.track({ res: first }, { clientId: 'phone' });
    presence.track({ res: second }, { sessionToken: 'client:phone' });
    expect([...presence.connectedIds()]).toEqual(['phone']);
    first.emit('close');
    expect([...presence.connectedIds()]).toEqual(['phone']);
    second.emit('finish');
    expect([...presence.connectedIds()]).toEqual([]);
  });
  it('does not promote anonymous, ended, or another host’s streams', () => {
    const presence = createClientPresence();
    presence.track({ res: response('text/event-stream') }, { sessionToken: 'url:authenticated' });
    const res = response('text/event-stream');
    presence.track({ res }, { clientId: 'phone' });
    res.destroyed = true;
    expect([...presence.connectedIds()]).toEqual([]);
    expect([...createClientPresence().connectedIds()]).toEqual([]);
    res.emit('close');
  });
});
