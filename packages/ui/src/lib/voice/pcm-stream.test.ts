import { describe, expect, it, vi } from 'vitest';
import { playPcmStream } from './pcm-stream';

function fixture() {
  const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended: (() => void) | null; buffer: AudioBuffer | null; detune: { value: number }; connect: ReturnType<typeof vi.fn> }> = [];
  const context = {
    currentTime: 0,
    destination: {},
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
    createBuffer: (_channels: number, samples: number, rate: number) => ({ duration: samples / rate, getChannelData: () => new Float32Array(samples) }),
    createBufferSource: () => {
      const source = { start: vi.fn(), stop: vi.fn(() => source.onended?.()), disconnect: vi.fn(), onended: null as (() => void) | null, buffer: null as AudioBuffer | null, detune: { value: 0 }, connect: vi.fn() };
      sources.push(source);
      return source;
    },
  };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ start(c) { controller = c; }, cancel }));
  const send = (frame: object) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
  const abort = new AbortController();
  const onStart = vi.fn();
  const play = (pitch = 1) => playPcmStream(response, context as unknown as AudioContext, { signal: abort.signal, pitch, volume: 1, onStart });
  return { sources, context, controller, cancel, send, abort, onStart, play };
}

describe('streaming PCM playback', () => {
  it('re-buffers after starvation instead of repeatedly playing isolated packets', async () => {
    const f = fixture();
    const playing = f.play();
    const packet = { type: 'audio', data: btoa('\x00\x40'.repeat(4800)) };
    f.send(packet);
    f.send(packet);
    await vi.waitFor(() => expect(f.sources).toHaveLength(2));
    f.sources.forEach((source) => source.onended?.());
    f.context.currentTime = 1;
    f.send(packet);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.sources).toHaveLength(2);
    f.context.currentTime = 1.25;
    f.send(packet);
    await vi.waitFor(() => expect(f.sources).toHaveLength(4));
    expect(f.sources[2].start.mock.calls[0][0]).toBeCloseTo(1.27);
    expect(f.sources[3].start.mock.calls[0][0]).toBeCloseTo(1.47);
    expect(f.onStart).toHaveBeenCalledOnce();
    f.send({ type: 'done' });
    f.controller.close();
    f.sources.slice(2).forEach((source) => source.onended?.());
    await playing;
  });

  it('measures pre-buffering in playback time when pitch speeds up audio', async () => {
    const f = fixture();
    const playing = f.play(2);
    const packet = { type: 'audio', data: btoa('\x00\x40'.repeat(4800)) };
    for (let i = 0; i < 3; i++) f.send(packet);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(f.sources).toHaveLength(0);
    f.send(packet);
    await vi.waitFor(() => expect(f.sources).toHaveLength(4));
    expect(f.sources[3].start.mock.calls[0][0]).toBeCloseTo(0.32);
    f.send({ type: 'done' });
    f.controller.close();
    f.sources.forEach((source) => source.onended?.());
    await playing;
  });

  it.each(['abort', 'error', 'truncated'])('does not play buffered audio on %s before startup', async (failure) => {
    const f = fixture();
    const playing = f.play();
    const rejected = expect(playing).rejects.toThrow();
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(2400)) });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    if (failure === 'abort') f.abort.abort();
    else {
      if (failure === 'error') f.send({ type: 'error' });
      f.controller.close();
    }
    await rejected;
    expect(f.sources).toHaveLength(0);
    expect(f.onStart).not.toHaveBeenCalled();
  });

  it('plays continuously when packets arrive with moderate jitter', async () => {
    const f = fixture();
    const playing = f.play();
    for (const time of [0, 0.25, 0.5]) {
      f.context.currentTime = time;
      f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    f.send({ type: 'done' });
    f.controller.close();
    await vi.waitFor(() => expect(f.sources).toHaveLength(3));
    const gaps = f.sources.slice(1).map((source, i) =>
      source.start.mock.calls[0][0] - (f.sources[i].start.mock.calls[0][0] + f.sources[i].buffer!.duration));
    f.sources.forEach((source) => source.onended?.());
    await playing;
    expect(gaps).toEqual([0, 0]);
  });

  it('starts before response EOF and completes only after the final audio ends', async () => {
    const f = fixture();
    const completed = vi.fn();
    const playing = f.play().then(completed);
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    await vi.waitFor(() => expect(f.onStart).toHaveBeenCalledOnce());
    expect(f.sources[0].start).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
    f.send({ type: 'audio', data: btoa('\x00\x20'.repeat(2400)) });
    f.send({ type: 'done' });
    f.controller.close();
    await vi.waitFor(() => expect(f.sources).toHaveLength(3));
    expect(f.sources[2].start.mock.calls[0][0]).toBeCloseTo(0.42);
    expect(completed).not.toHaveBeenCalled();
    f.sources.forEach((source) => source.onended?.());
    await playing;
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each(['error', 'truncated'])('stops queued audio on %s without completing successfully', async (failure) => {
    const f = fixture();
    const playing = f.play();
    const rejected = expect(playing).rejects.toThrow();
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    await vi.waitFor(() => expect(f.onStart).toHaveBeenCalledOnce());
    if (failure === 'error') f.send({ type: 'error' });
    f.controller.close();
    await rejected;
    expect(f.sources[0].stop).toHaveBeenCalledOnce();
  });

  it('cancels an open response and stops playback immediately', async () => {
    const f = fixture();
    const playing = f.play();
    const rejected = expect(playing).rejects.toThrow();
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    await vi.waitFor(() => expect(f.onStart).toHaveBeenCalledOnce());
    f.abort.abort();
    await rejected;
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.sources[0].stop).toHaveBeenCalledOnce();
  });

  it('handles split JSON and split PCM samples', async () => {
    const f = fixture();
    const playing = f.play();
    const bytes = new TextEncoder().encode('{"type":"audio","data":"AA=="}\n{"type":"audio","data":"QA=="}\n{"type":"done"}\n');
    for (const byte of bytes) f.controller.enqueue(Uint8Array.of(byte));
    f.controller.close();
    await vi.waitFor(() => expect(f.sources).toHaveLength(1));
    f.sources[0].onended?.();
    await playing;
  });

  it('bounds scheduled audio even when synthesis runs ahead of playback', async () => {
    const f = fixture();
    const playing = f.play();
    const rejected = expect(playing).rejects.toThrow();
    for (let i = 0; i < 100; i++) f.send({ type: 'audio', data: btoa('\x00\x40'.repeat(4800)) });
    await vi.waitFor(() => expect(f.sources.length).toBe(10));
    expect(f.sources.at(-1)!.start.mock.calls[0][0]).toBeLessThan(2);
    f.abort.abort();
    await rejected;
  });
});
