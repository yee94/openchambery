import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { synthesizeVolcengine, transcribeVolcengine } from './volcengine.js';
import { registerTtsRoutes } from './routes.js';

const nativeFetch = globalThis.fetch;

let dataDir;
beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-settings-'));
  vi.stubEnv('YURI_DATA_DIR', dataDir);
  await request(app()).put('/api/voice/settings').send({ voiceProvider: 'volcengine', sttProvider: 'volcengine' }).expect(200);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
const apiKey = 'test-speech-key';
const speech = { text: '你好', apiKey };
const audioLines = `${JSON.stringify({ code: 0, data: Buffer.from('audio').toString('base64') })}\n${JSON.stringify({ code: 20000000 })}\n`;
const mockResponse = (response) => {
  const upstream = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', upstream);
  return upstream;
};
const app = () => {
  const instance = express();
  instance.use(express.json());
  registerTtsRoutes(instance, { sayTTSCapability: null });
  return instance;
};

describe('Volcengine speech protocol', () => {
  it('preserves existing Host speech credentials and ASR settings when adopting unified storage', async () => {
    fs.rmSync(path.join(dataDir, 'speech', 'settings.json'));
    fs.mkdirSync(path.join(dataDir, 'speech'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'speech', 'volcengine.json'), JSON.stringify({ apiKey, voice: 'existing-speaker' }));
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ dictationEnabled: true, sttProvider: 'volcengine' }));
    const initial = await request(app()).get('/api/voice/settings').expect(200);
    expect(initial.body).toMatchObject({ configured: true, voice: 'existing-speaker', dictationEnabled: true, sttProvider: 'volcengine' });
    await request(app()).put('/api/voice/settings').send({ showMessageTTSButtons: true, voiceProvider: 'volcengine' }).expect(200);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'speech', 'settings.json'), 'utf8'))).toMatchObject({ apiKey, showMessageTTSButtons: true, dictationEnabled: true });
  });
  it('shares the complete TTS and ASR configuration with a fresh client', async () => {
    const tts = { showMessageTTSButtons: true, voiceProvider: 'volcengine', speechRate: 1.4, speechPitch: 1.1, speechVolume: 0.6, ttsInputMode: 'raw', apiKey };
    await request(app()).put('/api/voice/settings').send(tts).expect(200);
    await request(app()).put('/api/voice/settings').send({ dictationEnabled: true, sttProvider: 'volcengine', asrResourceId: 'volc.seedasr.sauc.concurrent' }).expect(200);
    const mobile = await request(app()).get('/api/voice/settings').expect(200);
    const { apiKey: _key, ...preferences } = tts;
    expect(mobile.body).toMatchObject({ ...preferences, configured: true, dictationEnabled: true, sttProvider: 'volcengine', asrResourceId: 'volc.seedasr.sauc.concurrent' });
    expect(JSON.stringify(mobile.body)).not.toContain(apiKey);
  });
  it('persists PC settings and exposes configured status to a fresh mobile client without returning the key', async () => {
    const saved = await request(app()).put('/api/voice/volcengine').send({ apiKey, voice: 'custom_speaker', resourceId: 'seed-icl-2.0' });
    expect(saved.status).toBe(200);
    const file = path.join(dataDir, 'speech', 'settings.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey).toBe(apiKey);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const mobile = await request(app()).get('/api/voice/volcengine');
    expect(mobile.body).toMatchObject({ configured: true, voice: 'custom_speaker', resourceId: 'seed-icl-2.0' });
    expect(JSON.stringify(mobile.body)).not.toContain(apiKey);
    expect(mobile.headers['cache-control']).toBe('no-store');
    const upstream = mockResponse(new Response(audioLines));
    const spoken = await request(app()).post('/api/tts/speak').send({ text: '测试', provider: 'openai', apiKey: 'ignored-key', voice: 'ignored-voice', resourceId: 'ignored-resource', speed: 2 });
    expect(spoken.status).toBe(200);
    expect(upstream.mock.calls[0][1].headers['X-Api-Key']).toBe(apiKey);
    expect(JSON.parse(upstream.mock.calls[0][1].body).req_params.speaker).toBe('custom_speaker');
    expect(JSON.parse(upstream.mock.calls[0][1].body).req_params.audio_params.speech_rate).toBe(0);
    expect(upstream.mock.calls[0][1].headers['X-Api-Resource-Id']).toBe('seed-icl-2.0');
  });
  it('merges independent TTS/ASR saves, preserves an omitted key, and explicitly clears it', async () => {
    await request(app()).put('/api/voice/volcengine').send({ apiKey, voice: 'custom_speaker' }).expect(200);
    const saved = await request(app()).put('/api/voice/volcengine').send({ asrResourceId: 'volc.seedasr.sauc.concurrent' }).expect(200);
    expect(saved.body).toMatchObject({ configured: true, voice: 'custom_speaker', asrResourceId: 'volc.seedasr.sauc.concurrent' });
    const cleared = await request(app()).put('/api/voice/volcengine').send({ apiKey: '' }).expect(200);
    expect(cleared.body.configured).toBe(false);
    await request(app()).post('/api/tts/speak').send({ text: '测试', provider: 'volcengine' }).expect(400);
  });
  it('rejects malformed updates and preserves saved data when the atomic write fails', async () => {
    await request(app()).put('/api/voice/volcengine').send({ apiKey, voice: 'original' }).expect(200);
    await request(app()).put('/api/voice/volcengine').send({ apiKey: 'invalid\nkey' }).expect(400);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('private filesystem details'); });
    const failed = await request(app()).put('/api/voice/volcengine').send({ voice: 'changed' }).expect(500);
    expect(JSON.stringify(failed.body)).not.toContain('private filesystem details');
    rename.mockRestore();
    expect((await request(app()).get('/api/voice/volcengine')).body).toMatchObject({ configured: true, voice: 'original' });
  });
  it('reports a corrupt settings file as failure without overwriting it or returning empty success', async () => {
    await request(app()).put('/api/voice/volcengine').send({ apiKey }).expect(200);
    const file = path.join(dataDir, 'speech', 'settings.json');
    fs.writeFileSync(file, '{invalid');
    await request(app()).get('/api/voice/volcengine').expect(500);
    await request(app()).put('/api/voice/volcengine').send({ voice: 'new' }).expect(500);
    expect(fs.readFileSync(file, 'utf8')).toBe('{invalid');
  });
  it('uses the saved speech key for file transcription with no client key', async () => {
    await request(app()).put('/api/voice/volcengine').send({ apiKey }).expect(200);
    const upstream = mockResponse(new Response('{"result":{"text":"测试"}}', { headers: { 'X-Api-Status-Code': '20000000' } }));
    const result = await request(app()).post('/api/stt/transcribe')
      .set('Content-Type', 'audio/wav').send(Buffer.from('wav')).expect(200);
    expect(result.body.transcript).toBe('测试');
    expect(upstream.mock.calls[0][1].headers['X-Api-Key']).toBe(apiKey);
  });
  it('flushes first audio over HTTP before synthesis ends and aborts upstream on disconnect', async () => {
    await request(app()).put('/api/voice/settings').send({ apiKey }).expect(200);
    let controller;
    const upstream = mockResponse(new Response(new ReadableStream({ start(c) { controller = c; } })));
    const server = app().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const abort = new AbortController();
    try {
      const responsePromise = nativeFetch(`http://127.0.0.1:${server.address().port}/api/tts/speak`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ text: speech.text }), signal: abort.signal,
      });
      controller.enqueue(new TextEncoder().encode('{"code":0,"data":"AABAQA=="}\n'));
      const response = await responsePromise;
      const first = await response.body.getReader().read();
      expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({ type: 'audio', data: 'AABAQA==' });
      abort.abort();
      await vi.waitFor(() => expect(upstream.mock.calls[0][1].signal.aborted).toBe(true));
    } finally {
      abort.abort();
      controller.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  it('delivers PCM before upstream completion, including fragmented JSON', async () => {
    let controller;
    const upstream = mockResponse(new Response(new ReadableStream({ start(c) { controller = c; } })));
    const chunks = [];
    const completed = vi.fn();
    const pending = synthesizeVolcengine({ ...speech, onAudio: async (chunk) => { chunks.push(chunk); } }).then(completed);
    const first = JSON.stringify({ code: 0, data: 'AABAQA==' });
    controller.enqueue(new TextEncoder().encode(first.slice(0, 8)));
    controller.enqueue(new TextEncoder().encode(`${first.slice(8)}\n`));
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    expect(completed).not.toHaveBeenCalled();
    expect(JSON.parse(upstream.mock.calls[0][1].body).req_params.audio_params.format).toBe('pcm');
    controller.enqueue(new TextEncoder().encode('{"code":20000000}\n'));
    controller.close();
    await pending;
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each([true, false])('streams audio and explicit completion/error through the route (success=%s)', async (success) => {
    await request(app()).put('/api/voice/settings').send({ apiKey }).expect(200);
    mockResponse(new Response('{"code":0,"data":"AABAQA=="}\n' + (success ? '{"code":20000000}\n' : '')));
    const result = await request(app()).post('/api/tts/speak').set('Accept', 'application/x-ndjson').send({ text: speech.text });
    expect(result.headers['content-type']).toContain('application/x-ndjson');
    const frames = result.text.trim().split('\n').map(JSON.parse);
    expect(frames).toEqual([{ type: 'audio', data: 'AABAQA==' }, success ? { type: 'done' } : { type: 'error', error: expect.any(String) }]);
  });
  it('reports a missing speech key as a configuration error rather than HTTP 500', async () => {
    const upstream = mockResponse(new Response());
    const result = await request(app()).post('/api/tts/speak').send({ text: '测试', provider: 'volcengine', apiKey: '' });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain('API Key');
    expect(upstream).not.toHaveBeenCalled();
  });
  it('authenticates with the speech key and decodes chunked MP3 without forwarding arbitrary origins', async () => {
    const upstream = mockResponse(new Response(audioLines));
    const result = await synthesizeVolcengine({ ...speech, speed: 1.5, baseURL: 'https://invalid.example' });
    expect(result.buffer.toString()).toBe('audio');
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    expect(init.headers).toMatchObject({ 'X-Api-Key': apiKey, 'X-Api-Resource-Id': 'seed-tts-2.0' });
    expect(JSON.parse(init.body).req_params).toMatchObject({ speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'mp3', speech_rate: 50 } });
    expect(JSON.parse(JSON.parse(init.body).req_params.additions).context_texts).toEqual([expect.stringContaining('情感')]);
  });

  it('does not send Vivi emotional instructions to custom or cloned speakers', async () => {
    const upstream = mockResponse(new Response(audioLines));
    await synthesizeVolcengine({ ...speech, resourceId: 'seed-icl-2.0', voice: 'custom_speaker' });
    expect(JSON.parse(upstream.mock.calls[0][1].body).req_params.additions).toBeUndefined();
  });

  it.each([
    ['{"code":0,"data":"YQ=="}\n', 'before synthesis completed'],
    ['{"code":45000001,"message":"sensitive upstream text"}\n', 'code 45000001'],
    ['not json test-speech-key', 'Invalid Volcengine JSON'],
    ['{"code":20000000}\n', 'no audio'],
  ])('rejects incomplete or failed synthesis', async (body, error) => {
    mockResponse(new Response(body));
    await expect(synthesizeVolcengine(speech)).rejects.toThrow(error);
  });

  it('does not call upstream with missing credentials or invalid speed', async () => {
    const upstream = mockResponse(new Response());
    await expect(synthesizeVolcengine({ text: 'hello' })).rejects.toThrow('API Key');
    await expect(synthesizeVolcengine({ ...speech, speed: 4 })).rejects.toThrow('speed');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('requires ASR business success, even for HTTP 200', async () => {
    mockResponse(new Response('{"result":{"text":""}}', { headers: { 'X-Api-Status-Code': '45000001' } }));
    await expect(transcribeVolcengine({ apiKey, audioBuffer: Buffer.from('wav') })).rejects.toThrow('45000001');
  });

  it('uploads base64 audio and reads the transcript', async () => {
    const upstream = mockResponse(new Response('{"result":{"text":"你好。"}}', { headers: { 'X-Api-Status-Code': '20000000' } }));
    expect(await transcribeVolcengine({ apiKey, audioBuffer: Buffer.from('wav') })).toBe('你好。');
    const [url, init] = upstream.mock.calls[0];
    expect(url).toContain('/recognize/flash');
    expect(init.headers).toMatchObject({ 'X-Api-Key': apiKey, 'X-Api-Resource-Id': 'volc.bigasr.auc_turbo', 'X-Api-Sequence': '-1' });
    expect(JSON.parse(init.body).audio.data).toBe(Buffer.from('wav').toString('base64'));
  });

  it('distinguishes authoritative silence from malformed success', async () => {
    mockResponse(new Response('{}', { headers: { 'X-Api-Status-Code': '20000003' } }));
    expect(await transcribeVolcengine({ apiKey, audioBuffer: Buffer.from('wav') })).toBe('');
    mockResponse(new Response('{}', { headers: { 'X-Api-Status-Code': '20000000' } }));
    await expect(transcribeVolcengine({ apiKey, audioBuffer: Buffer.from('wav') })).rejects.toThrow('invalid transcript');
  });

  it('returns audio through the existing route without requiring OpenAI credentials', async () => {
    await request(app()).put('/api/voice/settings').send({ apiKey }).expect(200);
    mockResponse(new Response(audioLines));
    const result = await request(app()).post('/api/tts/speak').send({ text: speech.text });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('audio/mpeg');
    expect(result.body.toString()).toBe('audio');
  });

  it('keeps runtime authorization separate from the speech key', async () => {
    await request(app()).put('/api/voice/settings').send({ apiKey }).expect(200);
    const upstream = mockResponse(new Response('{"result":{"text":"测试"}}', { headers: { 'X-Api-Status-Code': '20000000' } }));
    const result = await request(app()).post('/api/stt/transcribe')
      .set('Content-Type', 'audio/wav').set('Authorization', 'Bearer runtime-token')
      .set('X-Speech-Provider', 'openai-compatible').set('X-Speech-Api-Key', 'ignored-key').send(Buffer.from('wav'));
    expect(result.status).toBe(200);
    expect(result.body.transcript).toBe('测试');
    expect(upstream.mock.calls[0][1].headers['X-Api-Key']).toBe(apiKey);
    expect(upstream.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
