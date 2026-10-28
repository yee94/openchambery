import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { preparePluginGuiRequest, projectPluginGuiResponse } from './plugin-gui-response.js';

const revision = 'revision-with-private-path';
const token = createHash('sha256').update(revision).digest('hex');
const envelope = { location: { directory: '/workspace' }, data: { code: 'module.exports = {};', revision, options: { key: 'current-value' } } };
const response = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'x-upstream': 'kept', etag: 'upstream-etag' },
});

describe('GUI code-only revision protocol', () => {
  it('is exact GET with one nonempty id and strips only GUI/conditional request controls', () => {
    for (const [method, path] of [
      ['POST', '/api/plugin/gui?id=x'], ['HEAD', '/api/plugin/gui?id=x'],
      ['GET', '/api/plugin/gui/child?id=x'], ['GET', '/api/plugin/gui/?id=x'],
      ['GET', '/api/plugin'], ['GET', '/api/plugin/gui'], ['GET', '/api/plugin/gui?id='],
      ['GET', '/api/plugin/gui?id=x&id=y'],
    ]) expect(preparePluginGuiRequest(method, path, {})).toBeNull();
    const headers = { 'X-Yuri-Gui-Revision': token, 'If-None-Match': 'old', 'If-Modified-Since': 'yesterday',
      Range: 'bytes=0-20', Authorization: 'upstream-auth', 'x-opencode-directory': '/workspace', accept: 'application/json' };
    expect(preparePluginGuiRequest('GET', '/api/plugin/gui?id=x&location%5Bdirectory%5D=%2Fworkspace', headers)).toEqual({
      revision: token, headers: { Authorization: 'upstream-auth', 'x-opencode-directory': '/workspace', accept: 'application/json', 'accept-encoding': 'identity' },
    });
    expect(headers['If-None-Match']).toBe('old');
    for (const value of ['*', token.toUpperCase(), '"' + token + '"', 'not-a-token']) {
      expect(preparePluginGuiRequest('GET', '/api/plugin/gui?id=x', { 'x-yuri-gui-revision': value }).revision).toBeNull();
    }
  });

  it('keeps original bytes without opt-in and returns only a hashed revision', async () => {
    const raw = JSON.stringify(envelope, null, 2) + '\n';
    const result = await projectPluginGuiResponse(new Response(raw, { headers: { 'content-type': 'application/json' } }), null);
    expect(await result.text()).toBe(raw);
    expect(result.headers.get('x-yuri-gui-revision')).toBe(token);
    expect(result.headers.get('x-yuri-gui-code')).toBeNull();
    expect(result.headers.get('cache-control')).toBe('private, no-store');
  });

  it('omits only code on a matching revision, retaining fresh options and all envelope fields', async () => {
    for (const options of [{ key: 'new-value' }, { changed: [1, null] }]) {
      const input = { ...envelope, extra: 1, data: { ...envelope.data, options, extra: true } };
      const result = await projectPluginGuiResponse(response(input), token);
      expect(result.status).toBe(200);
      expect(result.headers.get('x-yuri-gui-code')).toBe('cached');
      expect(result.headers.get('etag')).toBeNull();
      expect(result.headers.get('x-upstream')).toBe('kept');
      expect(await result.json()).toEqual({ ...input, data: { ...input.data, code: '' } });
    }
    const changed = { ...envelope, data: { ...envelope.data, revision: 'new-revision' } };
    const result = await projectPluginGuiResponse(response(changed), token);
    expect(result.headers.get('x-yuri-gui-code')).toBeNull();
    expect(result.headers.get('x-yuri-gui-revision')).not.toBe(token);
    expect(await result.json()).toEqual(changed);
  });

  it.each([401, 403, 404, 429, 500, 503])('never replaces upstream %i with historical success', async (status) => {
    const upstream = response(envelope, status);
    expect(await projectPluginGuiResponse(upstream, token)).toBe(upstream);
    expect(await upstream.json()).toEqual(envelope);
  });

  it.each([
    { ...envelope.data, code: 1 }, { ...envelope.data, revision: '' },
    { ...envelope.data, revision: null }, { ...envelope.data, options: null },
    { ...envelope.data, options: [] }, { code: 'x', revision },
  ])('does not issue a revision receipt for malformed bundles: %j', async (data) => {
    const input = { ...envelope, data };
    const result = await projectPluginGuiResponse(response(input), token);
    expect(result.headers.get('x-yuri-gui-revision')).toBeNull();
    expect(result.headers.get('x-yuri-gui-code')).toBeNull();
    expect(await result.json()).toEqual(input);
  });

  it('preserves malformed JSON and non-JSON success bytes without a receipt', async () => {
    for (const [body, contentType] of [['{invalid', 'application/json'], ['<html>not a GUI</html>', 'text/html']]) {
      const result = await projectPluginGuiResponse(new Response(body, { headers: { 'content-type': contentType } }), token);
      expect(await result.text()).toBe(body);
      expect(result.headers.get('x-yuri-gui-code')).toBeNull();
    }
  });

  it('does not hide a failed body read behind a matching revision', async () => {
    const upstream = new Response(new ReadableStream({
      start(controller) { controller.error(new Error('upstream body failed')); },
    }), { headers: { 'content-type': 'application/json' } });
    await expect(projectPluginGuiResponse(upstream, token)).rejects.toThrow('upstream body failed');
  });
});
