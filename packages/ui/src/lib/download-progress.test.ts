import { expect, test, vi } from 'vitest';
import { readDownloadBlob } from './download-progress';

test.each([
    new Headers({ 'content-length': '8' }),
    new Headers({ 'content-range': 'bytes 0-7/8' }),
])('reports actual streamed bytes using length or Relay-safe Content-Range: %j', async (headers) => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers });
    const progress = vi.fn();
    const result = readDownloadBlob(response, undefined, progress);
    stream.enqueue(new Uint8Array([1, 2]));
    await vi.waitFor(() => expect(progress).toHaveBeenLastCalledWith(25));
    stream.enqueue(new Uint8Array([3, 4, 5, 6]));
    await vi.waitFor(() => expect(progress).toHaveBeenLastCalledWith(75));
    stream.enqueue(new Uint8Array([7, 8]));
    stream.close();
    expect(new Uint8Array(await (await result).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(progress).toHaveBeenLastCalledWith(100);
});

test.each([new Headers(), new Headers({ 'content-length': '2', 'content-encoding': 'gzip' })])('does not fabricate a percentage for unknown decoded lengths: %j', async (headers) => {
    const progress = vi.fn();
    const blob = await readDownloadBlob(new Response('decoded-body', { headers }), undefined, progress);
    expect(blob.size).toBe(12);
    expect(progress.mock.calls.map(([percent]) => percent)).toEqual([null, 100]);
});

test('an aborted read cancels the reader without reporting completion', async () => {
    const cancel = vi.fn();
    const progress = vi.fn();
    const controller = new AbortController();
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '8' } });
    const read = readDownloadBlob(response, controller.signal, progress);
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalledWith(100);
});

test('truncated and partial-range responses cannot be saved as complete downloads', async () => {
    const progress = vi.fn();
    await expect(readDownloadBlob(new Response('ab', { headers: { 'content-length': '8' } }), undefined, progress)).rejects.toThrow('Truncated');
    await expect(readDownloadBlob(new Response('ab', { headers: { 'content-range': 'bytes 0-1/8' } }), undefined, progress)).rejects.toThrow('Incomplete');
    expect(progress).not.toHaveBeenCalledWith(100);
});

test('small chunks only publish changed integer percentages', async () => {
    const progress = vi.fn();
    const body = new ReadableStream({ start(controller) {
        for (let i = 0; i < 1000; i++) controller.enqueue(new Uint8Array(1));
        controller.close();
    } });
    await readDownloadBlob(new Response(body, { headers: { 'content-length': '1000' } }), undefined, progress);
    expect(progress.mock.calls.map(([percent]) => percent)).toEqual(Array.from({ length: 101 }, (_, index) => index));
});
