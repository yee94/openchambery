import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { requestSpeechAudio } from '../../../../ui/src/lib/voice/direct-tts.ts';
import { DictationClient } from '../../../../ui/src/lib/dictation/dictation-client.ts';

const mocks = vi.hoisted(() => ({ runtimeFetch: vi.fn(), openRuntimeWebSocket: vi.fn(), identity: 'host-a' }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.runtimeFetch }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => mocks.identity }));
vi.mock('@/lib/relay/runtime-socket', () => ({ openRuntimeWebSocket: mocks.openRuntimeWebSocket }));
vi.mock('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({ websocket: () => 'wss://host.invalid/api/dictation/ws' }) }));
vi.mock('@/lib/runtime-auth', () => ({ refreshRuntimeUrlAuthToken: async () => {} }));

let server;
let urls;
let sockets;
let mode;
let audioChunks;
let clients;
let asrRequests;
const ticket = () => ({ transport: 'volcengine-direct', token: 'header.payload.signature', appId: 'fixture-app', expiresAt: Date.now() + 300000,
  resourceId: 'seed-tts-2.0', voice: 'zh_female_vv_uranus_bigtts', speed: 1, pitch: 1.1, volume: 0.8 });
const waitFor = async (fn) => { for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('Fixture timed out'); };
function ttsResponse(event, id, payload, type = 9) {
  const sid = Buffer.from(id);
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(16 + sid.length + data.length);
  frame.set([0x11, (type << 4) | 4, type === 11 ? 0 : 0x10, 0]);
  frame.writeUInt32BE(event, 4); frame.writeUInt32BE(sid.length, 8); sid.copy(frame, 12);
  frame.writeUInt32BE(data.length, 12 + sid.length); data.copy(frame, 16 + sid.length);
  return frame;
}
function asrResponse(text, final = false) {
  const data = gzipSync(Buffer.from(JSON.stringify(text === undefined ? {} : { result: { text } })));
  const frame = Buffer.alloc(12 + data.length);
  frame.set([0x11, final ? 0x93 : 0x91, 0x11, 0]);
  frame.writeInt32BE(final ? -1 : 1, 4); frame.writeUInt32BE(data.length, 8); data.copy(frame, 12);
  return frame;
}

beforeEach(async () => {
  urls = []; sockets = []; audioChunks = []; clients = []; mode = 'success'; mocks.identity = 'host-a';
  asrRequests = [];
  mocks.openRuntimeWebSocket.mockReset();
  mocks.runtimeFetch.mockReset().mockImplementation(async () => Response.json(ticket()));
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  vi.stubGlobal('WebSocket', class extends WebSocket {
    constructor(url) {
      urls.push(new URL(url));
      super(`ws://127.0.0.1:${server.address().port}${new URL(url).pathname}`);
    }
  });
  server.on('connection', (socket, req) => {
    sockets.push(socket);
    socket.on('message', (raw) => {
      const bytes = Buffer.from(raw);
      if (req.url.includes('/tts/')) {
        const event = bytes.readUInt32BE(4);
        const id = event >= 100 ? bytes.subarray(12, 12 + bytes.readUInt32BE(8)).toString() : '';
        if (event === 1) socket.send(ttsResponse(50, 'connection', {}));
        if (event === 100) socket.send(ttsResponse(150, id, {}));
        if (event === 200) socket.send(ttsResponse(352, id, Buffer.alloc(19200), 11));
        if (event === 102 && (mode === 'success' || mode === 'success-close')) socket.send(ttsResponse(152, id, {}));
        if (event === 102 && mode === 'success-close') socket.close();
        if (event === 102 && mode === 'failure') socket.send(ttsResponse(153, id, { message: 'private details' }));
        if (event === 102 && mode === 'truncated') socket.close();
      } else if ((bytes[1] >> 4) === 1) {
        asrRequests.push(JSON.parse(bytes.subarray(8).toString()));
      } else if ((bytes[1] >> 4) === 2) {
        if (bytes[1] & 2) { if (mode === 'success') socket.send(asrResponse(undefined, true)); else socket.close(); }
        else { audioChunks.push(bytes.subarray(8)); socket.send(asrResponse(`partial-${audioChunks.length}`)); }
      }
    });
  });
});
afterEach(async () => {
  for (const client of clients) client.cancelAllForRuntimeSwitch();
  for (const socket of sockets) socket.terminate();
  await new Promise((resolve) => server.close(resolve)); vi.unstubAllGlobals();
});

it('uses only a ticket request through runtime transport and streams TTS PCM directly', async () => {
  const response = await requestSpeechAudio('你好', new AbortController().signal);
  const frames = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  expect(frames.map((f) => f.type)).toEqual(['audio', 'audio', 'done']);
  expect(Buffer.from(frames[0].data, 'base64').length).toBe(9600);
  expect(response.headers.get('X-Speech-Pitch')).toBe('1.1');
  expect(mocks.runtimeFetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mocks.runtimeFetch.mock.calls[0][1].body)).toEqual({ kind: 'tts' });
  expect(urls[0].hostname).toBe('openspeech.bytedance.com');
  expect(urls[0].searchParams.get('api_access_key')).toBe('Jwt; header.payload.signature');
  expect(mocks.openRuntimeWebSocket).not.toHaveBeenCalled();
});

it('streams 100 ASR chunks in order, publishes live partials, and accepts a terminal frame without text', async () => {
  const client = new DictationClient(); clients.push(client);
  const partials = []; client.onPartial((_id, text) => partials.push(text));
  await client.startDictationStream('asr', 'audio/pcm;rate=16000;bits=16');
  for (let seq = 0; seq < 100; seq++) expect(client.sendDictationStreamChunk('asr', seq, Buffer.alloc(6400, seq).toString('base64'))).toBe(true);
  await waitFor(() => partials.length === 100);
  expect(await client.finishDictationStream('asr', 99)).toEqual({ text: 'partial-100' });
  expect(audioChunks).toHaveLength(100);
  expect(audioChunks.every((chunk, index) => chunk.equals(Buffer.alloc(6400, index)))).toBe(true);
  expect(mocks.runtimeFetch).toHaveBeenCalledTimes(1);
  expect(mocks.openRuntimeWebSocket).not.toHaveBeenCalled();
});

it.each([undefined, '', 'Mixed Mandarin and English.\nReact and "OpenCode".'])('sends the ticket context as serialized corpus or omits it: %s', async (asrContext) => {
  mocks.runtimeFetch.mockResolvedValueOnce(Response.json({ ...ticket(), asrContext }));
  const client = new DictationClient(); clients.push(client);
  await client.startDictationStream('context', 'audio/pcm;rate=16000;bits=16');
  await waitFor(() => asrRequests.length === 1);
  if (asrContext) expect(JSON.parse(asrRequests[0].request.corpus.context)).toEqual({ context_type: 'dialog_ctx', context_data: [{ text: asrContext }] });
  else expect(asrRequests[0].request).not.toHaveProperty('corpus');
});

it.each(['cancel', 'runtime'])('fences a late ticket after %s without opening any socket', async (reason) => {
  let resolve;
  mocks.runtimeFetch.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  const client = new DictationClient(); clients.push(client);
  const start = client.startDictationStream('late', 'audio/pcm;rate=16000;bits=16');
  const rejected = expect(start).rejects.toThrow();
  if (reason === 'cancel') client.cancelDictationStream('late'); else client.cancelAllForRuntimeSwitch();
  resolve(Response.json(ticket())); await rejected;
  expect(urls).toHaveLength(0); expect(mocks.openRuntimeWebSocket).not.toHaveBeenCalled();
});

it.each(['failure', 'truncated'])('does not report TTS success or relay fallback after %s', async (failureMode) => {
  mode = failureMode;
  const response = await requestSpeechAudio('测试', new AbortController().signal);
  await expect(response.text()).rejects.toThrow();
  expect(mocks.runtimeFetch).toHaveBeenCalledTimes(1);
});

it('closes the external TTS socket on stream cancellation', async () => {
  mode = 'wait';
  const response = await requestSpeechAudio('测试', new AbortController().signal);
  const reader = response.body.getReader(); await reader.read(); await reader.cancel();
  await waitFor(() => sockets[0].readyState === WebSocket.CLOSED);
});

it('drains a terminal TTS frame received before peer close while playback is backpressured', async () => {
  mode = 'success-close';
  const response = await requestSpeechAudio('测试', new AbortController().signal);
  const reader = response.body.getReader();
  await reader.read();
  await waitFor(() => sockets[0].readyState === WebSocket.CLOSED);
  let tail = '';
  while (true) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value); }
  expect(tail).toContain('"type":"done"');
});

it('does not treat failed ticket exchange as a fallback or empty transcript', async () => {
  mocks.runtimeFetch.mockResolvedValue(new Response('', { status: 502 }));
  await expect(requestSpeechAudio('测试', new AbortController().signal)).rejects.toThrow('Unable to create');
  const client = new DictationClient(); clients.push(client);
  await expect(client.startDictationStream('asr', 'audio/pcm;rate=16000;bits=16')).rejects.toThrow('Unable to create');
  expect(urls).toHaveLength(0); expect(mocks.openRuntimeWebSocket).not.toHaveBeenCalled();
});

it('closes active direct ASR on cancel and obtains a fresh ticket for the next recording', async () => {
  const client = new DictationClient(); clients.push(client);
  await client.startDictationStream('first', 'audio/pcm;rate=16000;bits=16');
  client.cancelDictationStream('first');
  await waitFor(() => sockets[0].readyState === WebSocket.CLOSED);
  await client.startDictationStream('second', 'audio/pcm;rate=16000;bits=16');
  expect(mocks.runtimeFetch).toHaveBeenCalledTimes(2);
  client.cancelAllForRuntimeSwitch();
  await waitFor(() => sockets[1].readyState === WebSocket.CLOSED);
});

it('rejects ASR finalization when the peer closes without a terminal frame', async () => {
  mode = 'truncated';
  const client = new DictationClient(); clients.push(client);
  await client.startDictationStream('asr', 'audio/pcm;rate=16000;bits=16');
  expect(client.sendDictationStreamChunk('asr', 0, 'AAAAAA==')).toBe(true);
  await expect(client.finishDictationStream('asr', 0)).rejects.toThrow();
  expect(mocks.openRuntimeWebSocket).not.toHaveBeenCalled();
});

it('rejects stale or expired tickets rather than exposing them to an external socket', async () => {
  mocks.runtimeFetch.mockResolvedValueOnce(Response.json({ ...ticket(), expiresAt: Date.now() - 1 }));
  await expect(requestSpeechAudio('测试', new AbortController().signal)).rejects.toThrow('Invalid speech session');
  mocks.runtimeFetch.mockImplementationOnce(async () => { mocks.identity = 'host-b'; return Response.json(ticket()); });
  await expect(requestSpeechAudio('测试', new AbortController().signal)).rejects.toThrow('runtime changed');
  expect(urls).toHaveLength(0);
});

it.each([123, 'x'.repeat(2001), 'bad\0context'])('rejects malformed ASR context before opening a provider socket', async (asrContext) => {
  mocks.runtimeFetch.mockResolvedValueOnce(Response.json({ ...ticket(), asrContext }));
  const client = new DictationClient(); clients.push(client);
  await expect(client.startDictationStream('invalid', 'audio/pcm;rate=16000;bits=16')).rejects.toThrow('Invalid speech session');
  expect(urls).toHaveLength(0);
});
