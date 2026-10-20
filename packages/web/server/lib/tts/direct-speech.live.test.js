import { afterEach, expect, it, vi } from 'vitest';
import { createSpeechTicket } from './direct-session.js';
import { Pcm16MonoResampler } from '../dictation/audio.js';
import { requestSpeechAudio } from '../../../../ui/src/lib/voice/direct-tts.ts';
import { DirectDictation } from '../../../../ui/src/lib/dictation/volcengine-direct.ts';

const { runtimeFetch } = vi.hoisted(() => ({ runtimeFetch: vi.fn() }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => 'live-speech' }));
afterEach(() => vi.restoreAllMocks());

it.skipIf(!process.env.VOLCENGINE_SPEECH_API_KEY)('exchanges a new speech API Key and runs TTS 2.0 → ASR 2.0 on the browser protocol', async () => {
  const settings = {
    apiKey: process.env.VOLCENGINE_SPEECH_API_KEY, resourceId: 'seed-tts-2.0', asrResourceId: 'volc.seedasr.sauc.duration',
    voice: 'zh_female_vv_uranus_bigtts', speechRate: 1, speechPitch: 1, speechVolume: 1,
  };
  const abort = new AbortController();
  runtimeFetch.mockImplementation(async (path, options) => {
    expect(path).toBe('/api/voice/session');
    const ticket = await createSpeechTicket(settings, JSON.parse(options.body).kind, options.signal);
    return Response.json(ticket);
  });
  const response = await requestSpeechAudio('今天阳光很好，我们一起去公园散步。', abort.signal);
  const frames = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  expect(frames.at(-1)).toEqual({ type: 'done' });
  const audio = Buffer.concat(frames.filter((frame) => frame.type === 'audio').map((frame) => Buffer.from(frame.data, 'base64')));
  expect(audio.length).toBeGreaterThan(24000);
  const pcm = new Pcm16MonoResampler({ inputRate: 24000, outputRate: 16000 }).processChunk(audio);
  const partials = [];
  const session = new DirectDictation(abort, (text) => partials.push(text), () => {});
  try {
    await session.start(await createSpeechTicket(settings, 'asr', abort.signal), 'audio/pcm;rate=16000;bits=16');
    let seq = 0;
    for (let offset = 0; offset < pcm.length; offset += 6400) {
      expect(session.send(seq++, pcm.subarray(offset, offset + 6400).toString('base64'))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const result = await session.finish(seq - 1);
    expect(result.text).toContain('公园');
    expect(partials.length).toBeGreaterThan(0);
  } finally { session.cancel(); }
}, 60000);
