import { describe, expect, it, vi } from 'vitest';
import { registerMessageQueueRoutes } from './routes.js';

const prefix = '/api/openchamber/message-queue';
const registry = () => { const routes = new Map(); const app = {}; for (const method of ['get', 'post', 'patch', 'put', 'delete']) app[method] = (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler); return { app, route: (method, path) => routes.get(`${method} ${path}`) }; };
const response = () => ({ statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

describe('message queue routes', () => {
  it('uses unavailable code for disabled runtimes', () => { const { app, route } = registry(); registerMessageQueueRoutes(app, { messageQueueService: null }); const res = response(); route('GET', prefix)({}, res); expect(res).toMatchObject({ statusCode: 501, body: { code: 'unavailable' } }); });
  it('maps stable errors to code-only responses', () => { const { app, route } = registry(); registerMessageQueueRoutes(app, { messageQueueService: { admit: () => { const error = new Error('private detail'); error.code = 'attachment_total_limit'; throw error; } } }); const res = response(); route('POST', `${prefix}/items`)({ body: {} }, res); expect(res).toMatchObject({ statusCode: 413, body: { code: 'attachment_total_limit' } }); });
  it('maps admission payload limits to 413', () => { const { app, route } = registry(); registerMessageQueueRoutes(app, { messageQueueService: { admit: () => { const error = new Error('private detail'); error.code = 'admission_payload_limit'; throw error; } } }); const res = response(); route('POST', `${prefix}/items`)({ body: {} }, res); expect(res).toMatchObject({ statusCode: 413, body: { code: 'admission_payload_limit' } }); });
  it('registers reservation routes, wakes on release, and maps reserved conflicts', () => {
    const { app, route } = registry(); const reserveForEdit = vi.fn(() => ({ token: 'token' })); const releaseEditReservation = vi.fn(() => ({ released: true })); const renewEditReservation = vi.fn(() => { const error = new Error('expired'); error.code = 'reservation_expired'; throw error; }); const reservedRemove = vi.fn(() => { const error = new Error('reserved'); error.code = 'reserved'; throw error; }); const wake = vi.fn();
    registerMessageQueueRoutes(app, { messageQueueService: { reserveForEdit, releaseEditReservation, renewEditReservation, reservedRemove }, messageQueueRuntime: { wake } });
    const reserveResponse = response(); route('POST', `${prefix}/items/:queueItemID/reserve`)({ params: { queueItemID: 'item' }, body: { owner: 'editor' } }, reserveResponse); expect(reserveForEdit).toHaveBeenCalledWith({ owner: 'editor', queueItemID: 'item' });
    const releaseResponse = response(); route('POST', `${prefix}/items/:queueItemID/release`)({ params: { queueItemID: 'item' }, body: { token: 'token' } }, releaseResponse); expect(releaseEditReservation).toHaveBeenCalledWith({ token: 'token', queueItemID: 'item' }); expect(wake).toHaveBeenCalledTimes(1);
    const renewResponse = response(); route('POST', `${prefix}/items/:queueItemID/edit-reservations/:token/renew`)({ params: { queueItemID: 'item', token: 'token' }, body: { generation: 1, ttlMs: 1_000 } }, renewResponse); expect(renewEditReservation).toHaveBeenCalledWith({ generation: 1, ttlMs: 1_000, queueItemID: 'item', token: 'token' }); expect(renewResponse).toMatchObject({ statusCode: 409, body: { code: 'reservation_expired' } });
    const removeResponse = response(); route('DELETE', `${prefix}/items/:queueItemID/reserved-remove`)({ params: { queueItemID: 'item' }, body: {} }, removeResponse); expect(removeResponse).toMatchObject({ statusCode: 409, body: { code: 'reserved' } });
  });
  it('passes scope pagination and does not register a long-poll changes route', () => {
    const { app, route } = registry();
    const getScope = vi.fn(() => ({ scopeID: 'scope', items: [] }));
    registerMessageQueueRoutes(app, { messageQueueService: { getScope } });
    const scopeRes = response();
    route('GET', `${prefix}/scopes/:scopeID`)({ params: { scopeID: 'scope' }, query: { offset: '2', limit: '8', expectedRevision: '4' } }, scopeRes);
    expect(scopeRes.body).toEqual({ scopeID: 'scope', items: [] });
    expect(getScope).toHaveBeenCalledWith('scope', { offset: 2, limit: 8, expectedRevision: 4 });
    expect(route('GET', `${prefix}/changes`)).toBeUndefined();
  });
});
