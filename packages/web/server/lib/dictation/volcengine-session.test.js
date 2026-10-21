import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket, { WebSocketServer } from 'ws';
import { VolcengineTranscriptionSession } from './volcengine-session.js';
import { DictationStreamManager } from './stream-manager.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const response = (text, last = false) => {
  const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text } })));
  const header = Buffer.from([0x11, last ? 0x93 : 0x91, 0x11, 0]);
  const fields = Buffer.alloc(8);
  fields.writeInt32BE(last ? -1 : 1);
  fields.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, fields, payload]);
};

async function fixture({ fail = false, terminalWithoutText = false, disconnectOnFinish = false, asrContext = '' } = {}) {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const frames = [];
  wss.on('connection', (socket, request) => {
    expect(request.headers['x-api-key']).toBe('test-key');
    expect(request.headers['x-api-resource-id']).toBe('volc.seedasr.sauc.duration');
    socket.on('message', (raw) => {
      const bytes = Buffer.from(raw);
      const payload = gunzipSync(bytes.subarray(8));
      frames.push({ type: bytes[1] >> 4, final: Boolean(bytes[1] & 2), payload });
      if (bytes[1] >> 4 === 1) socket.send(response(''));
      else if (fail || (disconnectOnFinish && (bytes[1] & 2))) socket.close();
      else socket.send(response(bytes[1] & 2 ? (terminalWithoutText ? undefined : '你好世界。') : '你好', Boolean(bytes[1] & 2)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  const session = new VolcengineTranscriptionSession({ apiKey: 'test-key', asrContext }, {
    createSocket: (url, options) => {
      expect(url).toBe('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async');
      return new WebSocket(`ws://127.0.0.1:${server.address().port}`, options);
    },
  });
  cleanups.push(() => session.close());
  await session.connect();
  return { session, frames };
}

describe('Volcengine streaming dictation', () => {
  it.each(['', 'Mixed Mandarin and English.\nReact and "OpenCode".'])('sends configured context and omits empty context: %s', async (asrContext) => {
    const { frames } = await fixture({ asrContext });
    const { request } = JSON.parse(frames[0].payload);
    if (asrContext) expect(JSON.parse(request.corpus.context)).toEqual({ context_type: 'dialog_ctx', context_data: [{ text: asrContext }] });
    else expect(request).not.toHaveProperty('corpus');
  });
  it('retains the last full transcript when the successful terminal frame omits text', async () => {
    const { session } = await fixture({ terminalWithoutText: true });
    const partial = new Promise((resolve) => session.once('transcript', resolve));
    session.appendPcm16(Buffer.from([1, 0]));
    await partial;
    const result = new Promise((resolve) => {
      session.once('transcript', resolve);
      session.once('error', (error) => resolve({ error: error.message }));
    });
    session.commit();
    expect(await result).toMatchObject({ transcript: '你好', isFinal: true });
  });
  it('returns partial captions before commit and final corrected text after release', async () => {
    const { session, frames } = await fixture();
    const partial = new Promise((resolve) => session.once('transcript', resolve));
    session.appendPcm16(Buffer.from([1, 0, 2, 0]));
    expect(await partial).toMatchObject({ transcript: '你好', isFinal: false });
    expect(frames[1].payload).toEqual(Buffer.from([1, 0, 2, 0]));
    expect(JSON.parse(frames[0].payload).request).toMatchObject({ result_type: 'full', enable_nonstream: true });
    const final = new Promise((resolve) => session.once('transcript', resolve));
    session.commit();
    expect(await final).toMatchObject({ transcript: '你好世界。', isFinal: true });
    expect(frames[2].final).toBe(true);
  });

  it('does not treat unexpected disconnect as a successful empty transcript', async () => {
    const { session } = await fixture({ fail: true });
    const failure = new Promise((resolve) => session.once('error', resolve));
    session.appendPcm16(Buffer.from([1, 0]));
    expect((await failure).message).toContain('disconnected');
  });

  it('still fails if the stream disconnects after partials without a successful terminal frame', async () => {
    const { session } = await fixture({ disconnectOnFinish: true });
    const partial = new Promise((resolve) => session.once('transcript', resolve));
    session.appendPcm16(Buffer.from([1, 0]));
    await partial;
    const failure = new Promise((resolve) => session.once('error', resolve));
    session.commit();
    expect((await failure).message).toContain('disconnected');
  });

  it('passes live text through the manager without its 15-second auto commit', async () => {
    const { session } = await fixture();
    const events = [];
    const manager = new DictationStreamManager({ emit: (event) => events.push(event), createSttSession: async () => ({ session }) });
    await manager.handleStart('test', 'audio/pcm;rate=16000;bits=16');
    expect(manager.streams.get('test').autoCommitBytes).toBe(0);
    const partial = new Promise((resolve) => session.once('transcript', resolve));
    manager.handleChunk({ dictationId: 'test', seq: 0, audioBase64: Buffer.from([255, 15, 255, 15]).toString('base64') });
    await partial;
    expect(events.some((event) => event.type === 'partial' && event.payload.text === '你好')).toBe(true);
    const final = new Promise((resolve) => session.once('transcript', resolve));
    manager.handleFinish('test', 0);
    await final;
    expect(events.some((event) => event.type === 'final' && event.payload.text === '你好世界。')).toBe(true);
    manager.cleanupAll();
  });

  it('closes sessions that finish connecting after cancellation', async () => {
    let resolve;
    let closed = false;
    const events = [];
    const manager = new DictationStreamManager({ emit: (event) => events.push(event), createSttSession: () => new Promise((done) => { resolve = done; }) });
    const start = manager.handleStart('cancelled', 'audio/pcm;rate=16000');
    manager.handleCancel('cancelled');
    resolve({ session: { close: () => { closed = true; } } });
    await start;
    expect(closed).toBe(true);
    expect(manager.streams.size).toBe(0);
    expect(events).toEqual([]);
  });
});
