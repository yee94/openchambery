import { describe, expect, it, vi } from 'vitest';
import { generateOpenCodeText, parseDataUrl, MAX_ATTACHMENT_BYTES } from './generate.js';

const request = { providerID: 'test', modelID: 'model', messages: [{ role: 'system', content: 'Only our system' }, { role: 'user', content: 'hello' }] };
describe('clean generation', () => {
  it('preserves structured messages and tool definitions without a session envelope', async () => {
    const generateCompletion = vi.fn(async () => ({ text: '', toolCalls: [{ id: 'call1', name: 'read', arguments: { path: 'a' } }], finishReason: 'tool-calls' }));
    const tools = [{ name: 'read', description: 'Read', inputSchema: { type: 'object' } }];
    const result = await generateOpenCodeText({ ...request, tools, generateCompletion });
    expect(result.toolCalls).toHaveLength(1);
    expect(generateCompletion.mock.calls[0][0]).toMatchObject({ messages: request.messages, tools });
    expect(JSON.stringify(generateCompletion.mock.calls[0][0].messages)).not.toContain('Transport requirement');
  });

  it('retries only empty responses and does not replay the caller tools', async () => {
    vi.useFakeTimers();
    try {
      const generateCompletion = vi.fn().mockResolvedValueOnce({ text: '', toolCalls: [] }).mockResolvedValueOnce({ text: 'done', toolCalls: [] });
      const result = generateOpenCodeText({ ...request, generateCompletion });
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toMatchObject({ text: 'done' });
      expect(generateCompletion).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('keeps long inference alive without a default deadline and stops on cancellation', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const generateCompletion = vi.fn(async ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
      const result = generateOpenCodeText({ ...request, signal: controller.signal, generateCompletion }).then(value => ({ value }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(600_000);
      expect(generateCompletion).toHaveBeenCalledTimes(1);
      controller.abort();
      expect(await result).toMatchObject({ error: { name: 'AbortError' } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('does not retry authentication or bridge errors', async () => {
    const generateCompletion = vi.fn(async () => { throw new Error('unavailable'); });
    await expect(generateOpenCodeText({ ...request, retryEmptyTextUntilCancelled: true, generateCompletion })).rejects.toThrow('unavailable');
    expect(generateCompletion).toHaveBeenCalledTimes(1);
  });

  it('does not accept output truncation as a successful task', async () => {
    await expect(generateOpenCodeText({ ...request, generateCompletion: async () => ({ text: 'partial', finishReason: 'length' }) })).rejects.toThrow('length');
  });

  it('inlines text files but forwards supported images as bytes without session.prompt', async () => {
    const generateCompletion = vi.fn(async () => ({ text: 'ok' }));
    await generateOpenCodeText({ ...request, forwardImageParts: true, messages: [{ role: 'user', content: 'look', parts: [
      { type: 'file', mime: 'text/plain', filename: 'note.txt', url: 'data:text/plain;base64,aGVsbG8=' },
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,YQ==' },
    ] }], generateCompletion });
    expect(generateCompletion.mock.calls[0][0].messages[0]).toMatchObject({ content: 'look\n[file: note.txt (text/plain)]\nhello', parts: [{ mime: 'image/png' }] });
  });

  it('rejects malformed and oversized data URLs', () => {
    expect(parseDataUrl('https://example.com/file')).toBe(null);
    expect(parseDataUrl('data:text/plain;base64,')).toBe(null);
    expect(() => parseDataUrl(`data:text/plain;base64,${Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64')}`)).toThrow('Attachment exceeds');
  });
});
