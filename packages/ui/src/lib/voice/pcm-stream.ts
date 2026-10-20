/** Play the Host's 24 kHz mono signed-16-bit little-endian PCM stream. */
export async function playPcmStream(response: Response, context: AudioContext, options: {
  signal: AbortSignal;
  pitch: number;
  volume: number;
  onStart: () => void;
}): Promise<void> {
  if (!response.body) throw new Error('Speech response has no stream');
  const reader = response.body.getReader();
  const gain = context.createGain();
  gain.gain.value = options.volume;
  gain.connect(context.destination);
  const sources = new Set<AudioBufferSourceNode>();
  const endings = new Set<Promise<void>>();
  const decoder = new TextDecoder();
  let nextTime = context.currentTime;
  let pending = '';
  let carry: number | undefined;
  let started = false;
  let done = false;
  let bytes = 0;
  const playbackRate = Math.pow(2, options.pitch - 1);
  const buffered: AudioBuffer[] = [];
  let bufferedDuration = 0;
  let buffering = true;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
    for (const source of sources) source.stop();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  const schedule = async (buffer: AudioBuffer) => {
    // Bound scheduled audio to two seconds; pause reads rather than queue a whole reply.
    while (nextTime - context.currentTime > 2 && endings.size) {
      await Promise.race(endings);
      options.signal.throwIfAborted();
    }
    options.signal.throwIfAborted();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.detune.value = (options.pitch - 1) * 1200;
    source.connect(gain);
    let ended!: () => void;
    const ending = new Promise<void>((resolve) => { ended = resolve; });
    endings.add(ending);
    sources.add(source);
    source.onended = () => {
      sources.delete(source);
      endings.delete(ending);
      source.disconnect();
      ended();
    };
    const at = Math.max(nextTime, context.currentTime + 0.02);
    source.start(at);
    nextTime = at + buffer.duration / playbackRate;
    if (!started) { started = true; options.onStart(); }
  };
  const flushBuffered = async () => {
    for (const buffer of buffered) await schedule(buffer);
    buffered.length = 0;
    bufferedDuration = 0;
    buffering = false;
  };
  const consume = async (line: string) => {
    if (!line.trim()) return;
    if (done) throw new Error('Unexpected audio after speech completion');
    const frame = JSON.parse(line);
    if (frame.type === 'error') throw new Error('Speech synthesis interrupted or failed');
    if (frame.type === 'done') {
      done = true;
      // Short replies and the final tail must not wait for the buffer threshold.
      await flushBuffered();
      return;
    }
    if (frame.type !== 'audio' || typeof frame.data !== 'string' || frame.data.length > 12800) {
      throw new Error('Invalid speech audio frame');
    }
    const binary = atob(frame.data);
    const pcm = new Uint8Array(binary.length + (carry === undefined ? 0 : 1));
    let offset = 0;
    if (carry !== undefined) pcm[offset++] = carry;
    for (let i = 0; i < binary.length; i++) pcm[offset + i] = binary.charCodeAt(i);
    carry = pcm.length % 2 ? pcm[pcm.length - 1] : undefined;
    const samples = Math.floor(pcm.length / 2);
    if (!samples) return;
    const buffer = context.createBuffer(1, samples, 24000);
    const channel = buffer.getChannelData(0);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    // Accumulate 400ms of actual playback before starting or recovering from starvation.
    // Network packet boundaries must not dictate pauses in the audio timeline.
    if (nextTime < context.currentTime + 0.02) buffering = true;
    buffered.push(buffer);
    bufferedDuration += buffer.duration / playbackRate;
    if (!buffering || bufferedDuration >= 0.4) await flushBuffered();
  };
  try {
    options.signal.throwIfAborted();
    while (true) {
      const result = await reader.read();
      options.signal.throwIfAborted();
      if (result.done) break;
      bytes += result.value.length;
      if (bytes > 32 * 1024 * 1024) throw new Error('Speech stream exceeds the size limit');
      pending += decoder.decode(result.value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        await consume(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      if (pending.length > 16000) throw new Error('Speech frame exceeds the size limit');
    }
    pending += decoder.decode();
    if (pending.trim()) await consume(pending);
    if (!done || !started || carry !== undefined) throw new Error('Incomplete speech audio stream');
    await Promise.all(endings);
    options.signal.throwIfAborted();
  } finally {
    options.signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    for (const source of sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    gain.disconnect();
  }
}
