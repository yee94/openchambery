import { describe, expect, it } from 'vitest';

import {
  createReasoningOutboundFilter,
  createSseBlockSplitter,
  filterSseBlock,
  projectMessagesPayloadForReasoning,
  projectMessagesPayloadWithoutReasoning,
  readIncludeReasoningFromUrl,
  readIncludeReasoningQuery,
  shouldIncludeReasoning,
  stripIncludeReasoningParam,
} from './reasoning-projection';

describe('shouldIncludeReasoning / query helpers', () => {
  it('only treats the strict string false as disabled', () => {
    expect(shouldIncludeReasoning(undefined)).toBe(true);
    expect(shouldIncludeReasoning('true')).toBe(true);
    expect(shouldIncludeReasoning(false)).toBe(true);
    expect(shouldIncludeReasoning('false')).toBe(false);
    expect(shouldIncludeReasoning(['false'])).toBe(false);
  });

  it('reads query and URL forms and strips upstream param', () => {
    expect(readIncludeReasoningQuery({ includeReasoning: 'false' })).toBe(false);
    expect(readIncludeReasoningFromUrl('/api/event?includeReasoning=false')).toBe(false);
    expect(readIncludeReasoningFromUrl('/api/event')).toBe(true);
    expect(stripIncludeReasoningParam('/event?directory=/tmp&includeReasoning=false&x=1'))
      .toBe('/event?directory=%2Ftmp&x=1');
  });
});

describe('HTTP snapshot projection', () => {
  it('drops reasoning parts and keeps tokens.reasoning', () => {
    const record = {
      info: { id: 'msg_1', tokens: { reasoning: 99 } },
      parts: [
        { id: 'p_r', type: 'reasoning', text: 'secret chain' },
        { id: 'p_t', type: 'text', text: 'hello' },
      ],
    };
    const projected = projectMessagesPayloadWithoutReasoning(record) as typeof record;
    expect(projected.info.tokens.reasoning).toBe(99);
    expect(projected.parts).toEqual([{ id: 'p_t', type: 'text', text: 'hello' }]);
    expect(JSON.stringify(projected)).not.toContain('secret chain');
  });

  it('identity when unchanged; forReasoning gate', () => {
    const plain = { info: { id: 'm' }, parts: [{ type: 'text', text: 'x' }] };
    expect(projectMessagesPayloadWithoutReasoning(plain)).toBe(plain);
    expect(projectMessagesPayloadForReasoning(plain, true)).toBe(plain);
  });
});

describe('stateful stream filter', () => {
  it('strips version suffixes for dispatch on properties and data envelopes', () => {
    const filter = createReasoningOutboundFilter();

    expect(filter.projectEvent({
      type: 'session.next.reasoning.delta.1',
      properties: { delta: 'think' },
    })).toBeNull();
    expect(filter.projectEvent({
      type: 'session.next.reasoning.delta',
      data: { delta: 'think' },
    })).toBeNull();

    expect(filter.projectEvent({
      type: 'message.part.updated.1',
      properties: {
        part: { id: 'p_r', messageID: 'm1', type: 'reasoning', text: 'chain' },
      },
    })).toBeNull();

    const textUpdated = {
      type: 'message.part.updated.1',
      data: {
        part: { id: 'p_t', messageID: 'm1', type: 'text', text: 'hi' },
      },
    };
    expect(filter.projectEvent(textUpdated)).toBe(textUpdated);
    expect(textUpdated.type).toBe('message.part.updated.1');

    const textDelta = {
      type: 'message.part.delta.1',
      data: { messageID: 'm1', partID: 'p_t', field: 'text', delta: '!' },
    };
    expect(filter.projectEvent(textDelta)).toBe(textDelta);

    filter.projectEvent({
      type: 'message.part.updated',
      properties: { part: { id: 'p_r2', messageID: 'm1', type: 'reasoning', text: '' } },
    });
    expect(filter.projectEvent({
      type: 'message.part.delta.1',
      data: { messageID: 'm1', partID: 'p_r2', field: 'text', delta: 'secret' },
    })).toBeNull();
  });

  it('drops unknown deltas and bounds classification', () => {
    const filter = createReasoningOutboundFilter();
    expect(filter.projectEvent({
      type: 'message.part.delta',
      properties: { messageID: 'm1', partID: 'never', field: 'text', delta: 'x' },
    })).toBeNull();

    for (let i = 0; i < 8200; i += 1) {
      filter.projectEvent({
        type: 'message.part.updated',
        properties: { part: { id: `p_${i}`, messageID: 'm', type: 'text' } },
      });
    }
    expect(filter.knownPartCount()).toBeLessThanOrEqual(8192);
    filter.dispose();
    expect(filter.knownPartCount()).toBe(0);
  });
});

describe('SSE filter + CR-safe splitter', () => {
  it('does not split one event when CRLF straddles chunk boundaries', () => {
    const splitter = createSseBlockSplitter();
    const full = 'id: 1\r\ndata: {"type":"text","n":1}\r\ndata: more\r\n\r\n';
    const cut = full.indexOf('\r') + 1;
    expect(splitter.push(full.slice(0, cut))).toEqual([]);
    const second = splitter.push(full.slice(cut));
    expect(second).toHaveLength(1);
    expect(second[0]).toContain('data: more');
  });

  it('handles per-character chunking and UTF-8 without leaking reasoning', () => {
    const filter = createReasoningOutboundFilter();
    const splitter = createSseBlockSplitter();
    const stream =
      'id: a\ndata: {"type":"message.part.updated","properties":{"part":{"id":"t","messageID":"m","type":"text","text":"你好"}}}\n\n'
      + 'id: b\ndata: {"type":"session.next.reasoning.delta","properties":{"delta":"secret"}}\n\n'
      + 'id: c\ndata: {"type":"message.part.delta","properties":{"messageID":"m","partID":"t","field":"text","delta":"!"}}\n\n';

    const bytes = new TextEncoder().encode(stream);
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += 1) {
      for (const block of splitter.push(bytes.subarray(i, i + 1))) {
        const filtered = filterSseBlock(block, filter);
        if (filtered) out.push(filtered);
      }
    }
    for (const block of splitter.finish()) {
      const filtered = filterSseBlock(block, filter);
      if (filtered) out.push(filtered);
    }

    expect(out).toHaveLength(2);
    expect(out.join('')).toContain('你好');
    expect(out.join('')).not.toContain('secret');
    expect(out.join('')).not.toContain('reasoning');
  });

  it('keeps event order across mixed CRLF chunk splits', () => {
    const splitter = createSseBlockSplitter();
    const blocks = [
      ...splitter.push('id: 1\r\ndata: {"n":1}\r'),
      ...splitter.push('\n\r\nid: 2\r\ndata: {"n":2}\r\n\r\n'),
      ...splitter.finish(),
    ];
    expect(blocks.map((b) => {
      const line = b.split('\n').find((l) => l.startsWith('data:'));
      return JSON.parse(line!.slice(5)).n as number;
    })).toEqual([1, 2]);
  });
});

describe('performance: 10k reasoning deltas', () => {
  it('emits zero body bytes for reasoning while keeping text deltas', () => {
    const disabled = createReasoningOutboundFilter();
    disabled.projectEvent({
      type: 'message.part.updated',
      properties: { part: { id: 'p_text', messageID: 'm1', type: 'text', text: '' } },
    });
    disabled.projectEvent({
      type: 'message.part.updated',
      properties: { part: { id: 'p_reason', messageID: 'm1', type: 'reasoning', text: '' } },
    });

    let events = 0;
    let bytes = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const out = disabled.projectEvent({
        type: 'message.part.delta',
        properties: {
          messageID: 'm1',
          partID: 'p_reason',
          field: 'text',
          delta: `reasoning-token-${i}-xxxxxxxx`,
        },
      });
      if (out != null) {
        events += 1;
        bytes += JSON.stringify(out).length;
      }
    }
    expect(events).toBe(0);
    expect(bytes).toBe(0);
    const textDelta = {
      type: 'message.part.delta',
      properties: { messageID: 'm1', partID: 'p_text', field: 'text', delta: 'ok' },
    };
    expect(disabled.projectEvent(textDelta)).toBe(textDelta);
  });
});
