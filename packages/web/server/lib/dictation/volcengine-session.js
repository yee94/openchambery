import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';

const ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';

function encodeFrame(type, payload, last = false) {
  const compressed = gzipSync(payload);
  const head = Buffer.from([0x11, (type << 4) | (last ? 2 : 0), (type === 1 ? 0x10 : 0) | 1, 0]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(compressed.length);
  return Buffer.concat([head, size, compressed]);
}

function decodeFrame(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 8 || bytes[0] >> 4 !== 1) throw new Error('Invalid Volcengine ASR frame');
  const type = bytes[1] >> 4;
  const flags = bytes[1] & 15;
  let offset = (bytes[0] & 15) * 4;
  if (offset < 4) throw new Error('Invalid Volcengine ASR header');
  if (type === 15) {
    if (bytes.length < offset + 8) throw new Error('Invalid Volcengine ASR error frame');
    throw new Error(`Volcengine streaming ASR failed (code ${bytes.readUInt32BE(offset)}); check streaming service permissions`);
  }
  if (type !== 9) throw new Error('Unexpected Volcengine ASR message type');
  if (flags & 1) offset += 4;
  if (flags & 4) offset += 4;
  if (bytes.length < offset + 4) throw new Error('Truncated Volcengine ASR frame');
  const size = bytes.readUInt32BE(offset);
  offset += 4;
  if (size !== bytes.length - offset) throw new Error('Invalid Volcengine ASR payload size');
  const compression = bytes[2] & 15;
  if (compression !== 0 && compression !== 1) throw new Error('Unsupported Volcengine ASR compression');
  const payload = compression === 1 ? gunzipSync(bytes.subarray(offset), { maxOutputLength: 1024 * 1024 }) : bytes.subarray(offset);
  let message;
  try { message = JSON.parse(payload.toString('utf8')); }
  catch { throw new Error('Invalid Volcengine ASR response'); }
  if (message.code !== undefined && ![0, 1000, 20000000].includes(message.code)) {
    throw new Error(`Volcengine streaming ASR failed (code ${Number(message.code) || 'unknown'})`);
  }
  return { message, final: Boolean(flags & 2) };
}

export class VolcengineTranscriptionSession extends EventEmitter {
  constructor({ apiKey, resourceId = 'volc.seedasr.sauc.duration', asrContext = '' }, { createSocket = (url, options) => new WebSocket(url, options) } = {}) {
    super();
    this.apiKey = apiKey;
    this.resourceId = resourceId;
    this.asrContext = asrContext;
    this.createSocket = createSocket;
    this.requiredSampleRate = 16000;
    this.autoCommitSeconds = 0;
    this.segmentId = randomUUID();
    this.connected = false;
    this.closed = false;
    this.committed = false;
    this.completed = false;
    this.lastTranscript = null;
    this.bytes = 0;
  }

  async connect() {
    if (typeof this.apiKey !== 'string' || !this.apiKey.trim() || /[\r\n]/.test(this.apiKey)) throw new Error('Volcengine speech API Key is required');
    if (!['volc.seedasr.sauc.duration', 'volc.seedasr.sauc.concurrent', 'volc.bigasr.sauc.duration', 'volc.bigasr.sauc.concurrent'].includes(this.resourceId)) throw new Error('Invalid Volcengine streaming resource ID');
    const socket = this.createSocket(ENDPOINT, {
      headers: { 'X-Api-Key': this.apiKey.trim(), 'X-Api-Resource-Id': this.resourceId, 'X-Api-Request-Id': randomUUID() },
      handshakeTimeout: 10000,
      maxPayload: 1024 * 1024,
    });
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => fail(new Error('Volcengine streaming ASR connection timed out')), 10000);
      const fail = (error) => {
        if (this.closed) return;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        } else if (!this.completed) {
          this.emit('error', error);
        }
        this.close();
      };
      this.rejectConnect = () => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('Dictation cancelled')); }
      };
      socket.on('open', () => {
        if (this.closed) return;
        socket.send(encodeFrame(1, Buffer.from(JSON.stringify({
          user: { uid: 'openchamber' },
          audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
          request: { model_name: 'bigmodel', result_type: 'full', enable_itn: true, enable_punc: true, enable_nonstream: true, show_utterances: true,
            ...(this.asrContext.trim() ? { corpus: { context: JSON.stringify({ context_type: 'dialog_ctx', context_data: [{ text: this.asrContext.trim() }] }) } } : {}),
          },
        }))), (error) => { if (error) fail(new Error('Volcengine ASR request could not be sent')); });
      });
      socket.on('message', (data) => {
        if (this.closed || this.completed) return;
        try {
          const { message, final } = decodeFrame(data);
          if (!settled) { settled = true; clearTimeout(timeout); this.connected = true; resolve(); }
          const result = Array.isArray(message.result) ? message.result[0] : message.result;
          if (final && !this.committed) throw new Error('Volcengine ASR ended before recording was confirmed');
          if (typeof result?.text === 'string') {
            this.lastTranscript = result.text;
            this.emit('transcript', { segmentId: this.segmentId, transcript: result.text, isFinal: final });
          } else if (final && result?.text === undefined && this.lastTranscript !== null) {
            this.emit('transcript', { segmentId: this.segmentId, transcript: this.lastTranscript, isFinal: true });
          } else if (final) {
            throw new Error('Volcengine ASR returned no final transcript');
          }
          if (final) { this.completed = true; socket.close(); }
        } catch (error) { fail(error); }
      });
      socket.on('error', () => fail(new Error('Volcengine streaming ASR connection failed; check API Key and streaming service permissions')));
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        fail(new Error(`Volcengine streaming ASR HTTP ${response.statusCode}; enable ${this.resourceId}`));
      });
      socket.on('close', () => {
        if (!this.closed && !this.completed) fail(new Error('Volcengine ASR disconnected before the final transcript'));
      });
    });
  }

  appendPcm16(chunk) {
    if (!this.connected || this.closed || this.committed) return;
    this.bytes += chunk.length;
    if (this.bytes > 16000 * 2 * 300 || this.socket.bufferedAmount > 1024 * 1024) {
      this.emit('error', new Error('Volcengine ASR recording or network buffer limit exceeded'));
      this.close();
      return;
    }
    this.socket.send(encodeFrame(2, chunk));
  }

  commit() {
    if (!this.connected || this.closed || this.committed) return;
    this.committed = true;
    this.emit('committed', { segmentId: this.segmentId });
    this.socket.send(encodeFrame(2, Buffer.alloc(0), true));
  }

  clear() { this.close(); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.rejectConnect?.();
    this.socket?.terminate();
    this.apiKey = undefined;
  }
}
