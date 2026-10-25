import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({ speak: vi.fn(), transcribe: vi.fn(), localSpeak: vi.fn(), installed: vi.fn() }));
vi.mock('./index.js', () => ({ ttsService: { generateSpeechStream: mocks.speak, isAvailable: async () => false } }));
vi.mock('./stt.js', () => ({ transcribeAudio: mocks.transcribe }));
vi.mock('../dictation/local/model-downloader.js', () => ({ isLocalSttModelInstalled: mocks.installed, ensureLocalSttModel: vi.fn() }));
vi.mock('../dictation/local/worker-client.js', () => ({
  DictationWorkerClient: class { synthesizeSpeech = mocks.localSpeak; shutdown() {} },
  WorkerBackedTranscriptionSession: class {},
}));
import { registerTtsRoutes } from './routes.js';
import { createDictationService } from '../dictation/service.js';

let directory;
let app;
const save = (patch) => request(app).put('/api/voice/settings').send(patch).expect(200);
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-speech-'));
  vi.stubEnv('YURI_DATA_DIR', directory);
  vi.clearAllMocks();
  app = express();
  app.use(express.json());
  registerTtsRoutes(app, { sayTTSCapability: null });
  mocks.speak.mockResolvedValue({ buffer: Buffer.from('audio'), contentType: 'audio/mpeg' });
  mocks.transcribe.mockResolvedValue('transcript');
  mocks.installed.mockResolvedValue(true);
  mocks.localSpeak.mockResolvedValue({ audio: Buffer.from('wav'), format: 'audio/wav' });
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

it('uses the latest saved OpenAI configuration for text-only requests and ignores overrides', async () => {
  await save({ voiceProvider: 'openai', openaiApiKey: 'saved-key', openaiVoice: 'nova', speechRate: 1.3, speechPitch: 1.1, speechVolume: 0.6 });
  const response = await request(app).post('/api/tts/speak').send({ text: 'hello', provider: 'volcengine', apiKey: 'ignored', voice: 'ignored', speed: 2, baseURL: 'https://ignored.example', model: 'ignored' }).expect(200);
  expect(mocks.speak).toHaveBeenLastCalledWith({ text: 'hello', voice: 'nova', model: 'gpt-4o-mini-tts', speed: 1.3, apiKey: 'saved-key', baseURL: undefined });
  expect(response.headers).toMatchObject({ 'x-speech-pitch': '1.1', 'x-speech-volume': '0.6' });
  await save({ voiceProvider: 'openai-compatible', openaiCompatibleUrl: 'http://localhost:8880/v1', openaiCompatibleApiKey: 'custom-key', openaiCompatibleVoice: 'custom-voice', openaiCompatibleTtsModel: 'custom-model' });
  await request(app).post('/api/tts/speak').send({ text: 'next' }).expect(200);
  expect(mocks.speak).toHaveBeenLastCalledWith({ text: 'next', voice: 'custom-voice', model: 'custom-model', speed: 1.3, apiKey: 'custom-key', baseURL: 'http://localhost:8880/v1' });
});

it('resolves file ASR settings on the Host without forwarding runtime auth or configuration headers', async () => {
  await save({ sttProvider: 'openai-compatible', sttServerUrl: 'http://localhost:8001/v1', sttApiKey: 'asr-key', sttModel: 'saved-model', sttLanguage: 'zh' });
  await request(app).post('/api/stt/transcribe').set('Content-Type', 'audio/wav')
    .set('Authorization', 'Bearer runtime-token').set('X-Base-URL', 'https://ignored.example')
    .set('X-Model', 'ignored').set('X-Language', 'en').send(Buffer.from('wav')).expect(200);
  expect(mocks.transcribe).toHaveBeenCalledWith({ audioBuffer: Buffer.from('wav'), mimeType: 'audio/wav', baseURL: 'http://localhost:8001/v1', apiKey: 'asr-key', model: 'saved-model', language: 'zh' });
});

it('snapshots saved ASR configuration per session and reloads it for the next session', async () => {
  await save({ sttProvider: 'openai-compatible', sttApiKey: 'first-key', sttModel: 'first-model', sttLanguage: 'zh' });
  const service = createDictationService({ modelsDir: directory });
  const first = await service.createSttSession({ provider: 'local', openaiCompatible: { apiKey: 'ignored' } });
  expect(first.session.config).toMatchObject({ apiKey: 'first-key', model: 'first-model', language: 'zh' });
  await save({ sttApiKey: 'second-key', sttModel: 'second-model' });
  const second = await service.createSttSession();
  expect(second.session.config).toMatchObject({ apiKey: 'second-key', model: 'second-model' });
  expect(first.session.config.apiKey).toBe('first-key');
  first.session.close(); second.session.close(); service.shutdown();
});

it('uses saved local TTS voice and rate even when the caller supplies overrides', async () => {
  await save({ localTtsVoiceId: 3, speechRate: 1.4 });
  const service = createDictationService({ modelsDir: directory });
  await service.synthesizeSpeech({ text: 'hello', speakerId: 9, speed: 2, model: 'ignored' });
  expect(mocks.localSpeak).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello', speakerId: 3, speed: 1.4 }));
  service.shutdown();
});

it('does not fall back to request credentials when saved configuration cannot be read', async () => {
  await save({ voiceProvider: 'openai', openaiApiKey: 'saved' });
  fs.writeFileSync(path.join(directory, 'speech', 'settings.json'), '{invalid');
  await request(app).post('/api/tts/speak').send({ text: 'hello', apiKey: 'ignored' }).expect(500);
  expect(mocks.speak).not.toHaveBeenCalled();
});
