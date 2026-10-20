const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_FRAME = 1024 * 1024;

export function asrFrame(payload: Uint8Array, audio = false, last = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8 + payload.length);
  bytes.set([0x11, ((audio ? 2 : 1) << 4) | (last ? 2 : 0), audio ? 0 : 0x10, 0]);
  new DataView(bytes.buffer).setUint32(4, payload.length);
  bytes.set(payload, 8);
  return bytes;
}

export function ttsFrame(event: number, sessionId = '', payload: object = {}): Uint8Array<ArrayBuffer> {
  const id = encoder.encode(sessionId);
  const data = encoder.encode(JSON.stringify(payload));
  const bytes = new Uint8Array(12 + data.length + (sessionId ? 4 + id.length : 0));
  bytes.set([0x11, 0x14, 0x10, 0]);
  const view = new DataView(bytes.buffer);
  view.setInt32(4, event);
  let offset = 8;
  if (sessionId) { view.setUint32(offset, id.length); bytes.set(id, offset + 4); offset += 4 + id.length; }
  view.setUint32(offset, data.length);
  bytes.set(data, offset + 4);
  return bytes;
}

export async function decodeSpeechFrame(input: ArrayBuffer, kind: 'asr' | 'tts') {
  if (input.byteLength < 8 || input.byteLength > MAX_FRAME) throw new Error('Invalid speech frame size');
  const bytes = new Uint8Array(input);
  const view = new DataView(input);
  const type = bytes[1] >> 4;
  const flags = bytes[1] & 15;
  const compression = bytes[2] & 15;
  let offset = (bytes[0] & 15) * 4;
  if (bytes[0] >> 4 !== 1 || offset < 4 || offset > bytes.length - 4) throw new Error('Invalid speech frame');
  const integer = () => {
    if (offset + 4 > bytes.length) throw new Error('Truncated speech frame');
    const value = view.getUint32(offset); offset += 4; return value;
  };
  if (type === 15) throw new Error(`Speech provider failed (code ${integer()})`);
  if (type !== 9 && !(kind === 'tts' && type === 11)) throw new Error('Unexpected speech frame');
  if (flags & 1) integer();
  let event = 0;
  let sessionId = '';
  if (flags & 4) {
    event = integer();
    if (kind === 'tts') {
      const length = integer();
      if (length > 256 || offset + length > bytes.length) throw new Error('Invalid speech session ID');
      sessionId = decoder.decode(bytes.subarray(offset, offset + length)); offset += length;
    }
  }
  const length = integer();
  if (offset + length !== bytes.length) throw new Error('Truncated speech payload');
  let payload: Uint8Array<ArrayBuffer> = bytes.slice(offset);
  if (compression === 1) {
    const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > MAX_FRAME) throw new Error('Speech payload exceeds size limit');
        chunks.push(result.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    payload = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { payload.set(chunk, at); at += chunk.length; }
  } else if (compression !== 0) throw new Error('Unsupported speech compression');
  return { type, event, sessionId, final: Boolean(flags & 2), payload };
}

export function speechJson(payload: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(decoder.decode(payload));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid speech response');
  return value as Record<string, unknown>;
}

// The external provider socket intentionally bypasses the runtime/Relay socket.
// Only the ticket exchange uses runtimeFetch. No URL-bearing errors escape.
export async function openSpeechSocket(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const queue: ArrayBuffer[] = [];
  let queuedBytes = 0;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  let rejectConnect: ((error: Error) => void) | null = null;
  const close = (discard = true) => {
    signal.removeEventListener('abort', abort);
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onopen = null;
    if (discard) { queue.length = 0; queuedBytes = 0; }
    socket.close();
    wake?.();
  };
  const fail = (error: Error, discard = true) => {
    failure ??= error;
    rejectConnect?.(failure);
    close(discard);
  };
  const abort = () => fail(new DOMException('Speech cancelled', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  socket.onmessage = (message) => {
    if (!(message.data instanceof ArrayBuffer) || message.data.byteLength > MAX_FRAME) {
      fail(new Error('Invalid speech message')); return;
    }
    queuedBytes += message.data.byteLength;
    if (queuedBytes > 32 * 1024 * 1024 || queue.length >= 4096) { fail(new Error('Speech receive buffer exceeded')); return; }
    queue.push(message.data);
    wake?.();
  };
  socket.onerror = () => fail(new Error('Speech connection failed'));
  // A peer can close after its terminal frame while playback is backpressured.
  // Drain already received frames before deciding whether completion was absent.
  socket.onclose = () => fail(new Error('Speech connection ended before completion'), false);
  const timer = setTimeout(() => fail(new Error('Speech connection timed out')), 10000);
  try {
    await new Promise<void>((resolve, reject) => { rejectConnect = reject; socket.onopen = () => resolve(); });
  } finally { clearTimeout(timer); rejectConnect = null; }
  return {
    send(data: Uint8Array<ArrayBuffer>) {
      signal.throwIfAborted();
      if (failure) throw failure;
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount + data.length > MAX_FRAME) throw new Error('Speech send buffer exceeded');
      socket.send(data);
    },
    async read(): Promise<ArrayBuffer> {
      const timeout = setTimeout(() => fail(new Error('Speech response timed out')), 60000);
      try {
        while (!queue.length && !failure) await new Promise<void>((resolve) => { wake = resolve; });
        signal.throwIfAborted();
        if (!queue.length && failure) throw failure;
        const data = queue.shift()!;
        queuedBytes -= data.byteLength;
        return data;
      } finally { clearTimeout(timeout); wake = null; }
    },
    close() { failure ??= new DOMException('Speech closed', 'AbortError'); close(); },
  };
}
