import { describe, expect, it } from 'vitest';
import { stripSessionMessageNativePayload } from './native-payload.js';

describe('HTTP message native payload projection', () => {
  it('strips only provider replay fields, preserving business fields and upstream objects', () => {
    const message = {
      id: 'm', native: { replay: 'x'.repeat(234 * 1024) },
      metadata: { native: 'business' },
      content: [
        { type: 'reasoning', text: 'visible', native: { reasoningEncryptedContent: 'encrypted' } },
        { type: 'tool', native: { itemId: 'provider-item' }, input: { native: 'input' }, output: { native: 'output' } },
        { type: 'text', text: 'keep' },
      ],
    };
    const before = JSON.stringify(message);
    const payload = { data: [message], cursor: { next: 'opaque', native: 'cursor-business' }, native: 'envelope-business' };
    const projected = stripSessionMessageNativePayload(payload);
    expect(projected).toEqual({
      ...payload, data: [{ id: 'm', metadata: { native: 'business' }, content: [
        { type: 'reasoning', text: 'visible' },
        { type: 'tool', input: { native: 'input' }, output: { native: 'output' } },
        { type: 'text', text: 'keep' },
      ] }],
    });
    expect(JSON.stringify(message)).toBe(before);
    expect(projected.cursor).toBe(payload.cursor);
    expect(projected.data[0].content[2]).toBe(message.content[2]);
    expect(JSON.stringify(payload).length - JSON.stringify(projected).length).toBeGreaterThan(234 * 1024);
    expect(stripSessionMessageNativePayload(projected)).toBe(projected);
    expect(stripSessionMessageNativePayload([message])).toEqual(projected.data);
    expect(stripSessionMessageNativePayload({ info: message, parts: [{ input: { native: 'kept' } }] }))
      .toEqual({ info: projected.data[0], parts: [{ input: { native: 'kept' } }] });
  });
});
