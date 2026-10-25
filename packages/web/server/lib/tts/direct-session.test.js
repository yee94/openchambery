import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerTtsRoutes } from './routes.js';
import { parseSpeechSettings, speechDefaults } from '../../../../ui/src/lib/voice/speechSettings.ts';

let directory;
let app;
const jwt = (claims = { aud: ['test-app'], exp: Math.floor(Date.now() / 1000) + 300 }) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-speech-'));
  vi.stubEnv('YURI_DATA_DIR', directory);
  app = express(); app.use(express.json()); registerTtsRoutes(app, { sayTTSCapability: null });
  await request(app).put('/api/voice/settings').send({ apiKey: 'fixture-key', voiceProvider: 'volcengine', sttProvider: 'volcengine' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

it('exchanges only the saved key, returns bounded temporary credentials and snapshots each channel configuration', async () => {
  const fetch = vi.fn(async () => Response.json({ jwt_token: jwt() })); vi.stubGlobal('fetch', fetch);
  for (const kind of ['asr', 'tts']) {
    const result = await request(app).post('/api/voice/session').send({ kind, apiKey: 'ignored', resourceId: 'ignored', duration: 999999 }).expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toMatchObject({ transport: 'volcengine-direct', appId: 'test-app', resourceId: kind === 'asr' ? 'volc.seedasr.sauc.duration' : 'seed-tts-2.0' });
    expect(JSON.stringify(result.body)).not.toContain('fixture-key');
    if (kind === 'tts') expect(result.body).toMatchObject({ voice: 'zh_female_vv_uranus_bigtts', speed: 1, pitch: 1, volume: 1 });
    const [url, options] = fetch.mock.calls.at(-1);
    expect(url).toBe('https://openspeech.bytedance.com/api/v1/sts/token');
    expect(options.headers['X-Api-Key']).toBe('fixture-key');
    expect(JSON.parse(options.body)).toEqual({ duration: 300 });
  }
  expect(fs.readFileSync(path.join(directory, 'speech/settings.json'), 'utf8')).not.toContain('signature');
});

it('does not mint tickets for other providers, missing keys or malformed session kinds', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await request(app).post('/api/voice/session').send({ kind: 'unknown' }).expect(400);
  await request(app).put('/api/voice/settings').send({ voiceProvider: 'openai' });
  expect((await request(app).post('/api/voice/session').send({ kind: 'tts' }).expect(200)).body).toEqual({ transport: 'host' });
  await request(app).put('/api/voice/settings').send({ apiKey: '' });
  await request(app).post('/api/voice/session').send({ kind: 'asr' }).expect(400);
  expect(fetch).not.toHaveBeenCalled();
});

it('round-trips context, preserves it across unrelated saves and failed validation, and snapshots only saved ASR context', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ jwt_token: jwt() })));
  const initial = (await request(app).get('/api/voice/settings').expect(200)).body;
  expect(initial.asrContext).toBe(speechDefaults.asrContext);
  const { asrContext: _context, ...legacy } = initial;
  expect(parseSpeechSettings(legacy).asrContext).toBe('');
  const context = 'Mixed Mandarin and English.\nReact, "OpenCode", and APIs.';
  await request(app).put('/api/voice/settings').send({ asrContext: context }).expect(200);
  await request(app).put('/api/voice/settings').send({ speechRate: 1.2 }).expect(200);
  for (const asrContext of [42, null, 'x'.repeat(2001), 'bad\0text']) {
    await request(app).put('/api/voice/settings').send({ asrContext }).expect(400);
  }
  expect((await request(app).get('/api/voice/settings')).body.asrContext).toBe(context);
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'speech/settings.json'), 'utf8')).asrContext).toBe(context);
  expect((await request(app).post('/api/voice/session').send({ kind: 'asr', asrContext: 'ignored' })).body.asrContext).toBe(context);
  expect((await request(app).post('/api/voice/session').send({ kind: 'tts' })).body).not.toHaveProperty('asrContext');
  await request(app).put('/api/voice/settings').send({ asrContext: '  ' }).expect(200);
  expect((await request(app).post('/api/voice/session').send({ kind: 'asr' })).body.asrContext).toBe('');
});

it('rejects failed, oversized, malformed, expired and overlong tickets without leaking upstream details', async () => {
  for (const response of [
    new Response('fixture-key upstream-private', { status: 401 }),
    new Response('x'.repeat(17000)), Response.json({ jwt_token: 'bad' }),
    Response.json({ jwt_token: jwt({ aud: ['app'], exp: 1 }) }),
    Response.json({ jwt_token: jwt({ aud: ['app'], exp: Math.floor(Date.now() / 1000) + 86400 }) }),
    Response.json({ jwt_token: jwt({ aud: [], exp: Math.floor(Date.now() / 1000) + 300 }) }),
  ]) {
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const result = await request(app).post('/api/voice/session').send({ kind: 'tts' }).expect(502);
    expect(result.body).toEqual({ error: 'Unable to create speech session' });
  }
});
