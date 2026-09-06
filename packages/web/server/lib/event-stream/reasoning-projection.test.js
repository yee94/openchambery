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
} from './reasoning-projection.js';

describe('shouldIncludeReasoning / query helpers', () => {
  it('only treats the strict string false as disabled', () => {
    expect(shouldIncludeReasoning(undefined)).toBe(true);
    expect(shouldIncludeReasoning(null)).toBe(true);
    expect(shouldIncludeReasoning('')).toBe(true);
    expect(shouldIncludeReasoning('true')).toBe(true);
    expect(shouldIncludeReasoning('0')).toBe(true);
    expect(shouldIncludeReasoning('False')).toBe(true);
    expect(shouldIncludeReasoning(false)).toBe(true);
    expect(shouldIncludeReasoning('false')).toBe(false);
    expect(shouldIncludeReasoning(['false'])).toBe(false);
  });

  it('reads Express query and URL forms', () => {
    expect(readIncludeReasoningQuery({ includeReasoning: 'false' })).toBe(false);
    expect(readIncludeReasoningQuery({})).toBe(true);
    expect(readIncludeReasoningFromUrl('/api/event?includeReasoning=false')).toBe(false);
    expect(readIncludeReasoningFromUrl('/api/event')).toBe(true);
  });

  it('strips includeReasoning from upstream paths', () => {
    expect(stripIncludeReasoningParam('/event?directory=/tmp&includeReasoning=false&x=1'))
      .toBe('/event?directory=%2Ftmp&x=1');
    expect(stripIncludeReasoningParam('/event?directory=/tmp')).toBe('/event?directory=/tmp');
  });
});

describe('HTTP snapshot projection', () => {
  it('drops reasoning parts and keeps tokens.reasoning', () => {
    const record = {
      info: { id: 'msg_1', tokens: { input: 1, output: 2, reasoning: 99 } },
      parts: [
        { id: 'p_r', type: 'reasoning', text: 'secret chain' },
        { id: 'p_t', type: 'text', text: 'hello' },
      ],
    };
    const projected = projectMessagesPayloadWithoutReasoning(record);
    expect(projected.info.tokens.reasoning).toBe(99);
    expect(projected.parts).toEqual([{ id: 'p_t', type: 'text', text: 'hello' }]);
    expect(JSON.stringify(projected)).not.toContain('secret chain');
    expect(record.parts).toHaveLength(2);
  });

  it('projects list / records / cache envelopes with identity when unchanged', () => {
    const withReasoning = {
      info: { id: 'm1', tokens: { reasoning: 3 } },
      parts: [{ type: 'reasoning', text: 'nope' }, { type: 'text', text: 'ok' }],
    };
    expect(projectMessagesPayloadWithoutReasoning([withReasoning])[0].parts).toEqual([
      { type: 'text', text: 'ok' },
    ]);
    const page = projectMessagesPayloadWithoutReasoning({ records: [withReasoning], turnCount: 1 });
    expect(page.records[0].parts).toHaveLength(1);
    expect(page.turnCount).toBe(1);

    const cache = projectMessagesPayloadWithoutReasoning({
      available: true,
      record: withReasoning,
      records: [withReasoning],
    });
    expect(cache.record.parts).toHaveLength(1);
    expect(projectMessagesPayloadForReasoning(withReasoning, true)).toBe(withReasoning);

    const plain = { info: { id: 'm' }, parts: [{ type: 'text', text: 'x' }] };
    const list = [plain];
    expect(projectMessagesPayloadWithoutReasoning(list)).toBe(list);
    expect(projectMessagesPayloadWithoutReasoning(plain)).toBe(plain);
  });
});

describe('stateful stream filter', () => {
  it('strips version suffixes for dispatch but keeps original type on kept events', () => {
    const filter = createReasoningOutboundFilter();

    expect(filter.projectEvent({
      type: 'session.next.reasoning.delta.1',
      properties: { delta: 'think' },
    })).toBeNull();
    expect(filter.projectEvent({
      type: 'session.next.reasoning.delta',
      data: { delta: 'think' },
    })).toBeNull();

    // properties envelope + versioned type
    expect(filter.projectEvent({
      type: 'message.part.updated.1',
      properties: {
        part: { id: 'p_r', messageID: 'm1', type: 'reasoning', text: 'chain' },
      },
    })).toBeNull();

    // data envelope + versioned type — learn text, keep original type string
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

    // reasoning learned via properties; delta via data still drops
    filter.projectEvent({
      type: 'message.part.updated',
      properties: { part: { id: 'p_r2', messageID: 'm1', type: 'reasoning', text: '' } },
    });
    expect(filter.projectEvent({
      type: 'message.part.delta.1',
      data: { messageID: 'm1', partID: 'p_r2', field: 'text', delta: 'secret' },
    })).toBeNull();
  });

  it('drops explicit reasoning fields and unknown part deltas', () => {
    const filter = createReasoningOutboundFilter();
    expect(filter.projectEvent({
      type: 'message.part.delta',
      properties: { messageID: 'm1', partID: 'u', field: 'reasoning_content', delta: 'x' },
    })).toBeNull();
    expect(filter.projectEvent({
      type: 'message.part.delta',
      properties: { messageID: 'm1', partID: 'never', field: 'text', delta: 'leak?' },
    })).toBeNull();
  });

  it('forgets classification and bounds the map', () => {
    const filter = createReasoningOutboundFilter();
    filter.projectEvent({
      type: 'message.part.updated',
      properties: { part: { id: 'p1', messageID: 'm1', type: 'text' } },
    });
    expect(filter.knownPartCount()).toBe(1);
    filter.projectEvent({
      type: 'message.part.removed',
      properties: { messageID: 'm1', partID: 'p1' },
    });
    expect(filter.knownPartCount()).toBe(0);

    for (let i = 0; i < 8200; i += 1) {
      filter.projectEvent({
        type: 'message.part.updated',
        properties: { part: { id: `p_${i}`, messageID: 'm_big', type: 'text' } },
      });
    }
    expect(filter.knownPartCount()).toBeLessThanOrEqual(8192);
    filter.dispose();
    expect(filter.knownPartCount()).toBe(0);
  });

  it('does not mutate original objects when stripping embedded parts', () => {
    const filter = createReasoningOutboundFilter();
    const original = {
      type: 'message.updated',
      properties: {
        info: { id: 'm1', tokens: { reasoning: 7 } },
        parts: [
          { id: 'r', type: 'reasoning', text: 'hidden' },
          { id: 't', type: 'text', text: 'visible' },
        ],
      },
    };
    const projected = filter.projectEvent(original);
    expect(projected).not.toBe(original);
    expect(original.properties.parts).toHaveLength(2);
    expect(projected.properties.parts).toEqual([{ id: 't', type: 'text', text: 'visible' }]);
  });
});

describe('SSE filter + CR-safe splitter', () => {
  it('preserves wire identity for kept events and drops reasoning', () => {
    const filter = createReasoningOutboundFilter();
    const keptBlock = 'id: evt-1\ndata: {"type":"message.part.updated","properties":{"part":{"id":"p","messageID":"m","type":"text","text":"hi"}}}';
    const droppedBlock = 'id: evt-2\ndata: {"type":"session.next.reasoning.delta","properties":{"delta":"no"}}';
    const wrappedDrop = 'id: evt-3\ndata: {"directory":"/repo","payload":{"type":"session.next.reasoning.delta.1","properties":{"delta":"x"}}}';
    const wrappedKeep = 'id: evt-4\ndata: {"directory":"/repo","payload":{"type":"server.connected","properties":{}}}';

    expect(filterSseBlock(keptBlock, filter)).toBe(`${keptBlock}\n\n`);
    expect(filterSseBlock(droppedBlock, filter)).toBeNull();
    expect(filterSseBlock(wrappedDrop, filter)).toBeNull();
    expect(filterSseBlock(wrappedKeep, filter)).toContain('"directory":"/repo"');
  });

  it('does not split one event when CRLF straddles chunk boundaries', () => {
    const splitter = createSseBlockSplitter();
    // Multi-line data event with CRLF, split after lone CR of first line ending.
    const full = 'id: 1\r\ndata: {"type":"text","n":1}\r\ndata: more\r\n\r\n';
    const cut = full.indexOf('\r') + 1; // after first CR of first line's CRLF
    expect(full[cut - 1]).toBe('\r');
    expect(full[cut]).toBe('\n');

    const first = splitter.push(full.slice(0, cut));
    expect(first).toEqual([]); // must not complete on lone CR→LF
    const second = splitter.push(full.slice(cut));
    expect(second).toHaveLength(1);
    expect(second[0]).toContain('id: 1');
    expect(second[0]).toContain('data: more');
    expect(second[0]).not.toMatch(/^\s*$/);
  });

  it('handles per-character chunking and UTF-8 multi-byte without leaking reasoning', () => {
    const filter = createReasoningOutboundFilter();
    const splitter = createSseBlockSplitter();
    const stream =
      'id: a\ndata: {"type":"message.part.updated","properties":{"part":{"id":"t","messageID":"m","type":"text","text":"你好"}}}\n\n'
      + 'id: b\ndata: {"type":"session.next.reasoning.delta","properties":{"delta":"secret"}}\n\n'
      + 'id: c\ndata: {"type":"message.part.delta","properties":{"messageID":"m","partID":"t","field":"text","delta":"!"}}\n\n';

    const bytes = new TextEncoder().encode(stream);
    const out = [];
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
    expect(out.join('')).toContain('"type":"message.part.updated"');
    expect(out.join('')).toContain('"type":"message.part.delta"');
    expect(out.join('')).toContain('你好');
    expect(out.join('')).not.toContain('reasoning');
    expect(out.join('')).not.toContain('secret');
  });

  it('keeps event order across mixed CRLF chunk splits', () => {
    const splitter = createSseBlockSplitter();
    const chunks = [
      'id: 1\r\ndata: {"n":1}\r',
      '\n\r\nid: 2\r\ndata: {"n":2}\r\n\r\n',
    ];
    const blocks = [];
    for (const chunk of chunks) blocks.push(...splitter.push(chunk));
    blocks.push(...splitter.finish());
    expect(blocks.map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data:')).slice(5)).n))
      .toEqual([1, 2]);
  });
});

describe('performance: 10k reasoning deltas', () => {
  it('drops 10k reasoning deltas while still emitting known text deltas', () => {
    const disabled = createReasoningOutboundFilter();
    disabled.projectEvent({
      type: 'message.part.updated',
      properties: { part: { id: 'p_text', messageID: 'm1', type: 'text', text: '' } },
    });
    disabled.projectEvent({
      type: 'message.part.updated',
      properties: { part: { id: 'p_reason', messageID: 'm1', type: 'reasoning', text: '' } },
    });

    let disabledEvents = 0;
    let disabledBodyBytes = 0;
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
        disabledEvents += 1;
        disabledBodyBytes += JSON.stringify(out).length;
      }
    }

    const textDelta = {
      type: 'message.part.delta',
      properties: { messageID: 'm1', partID: 'p_text', field: 'text', delta: 'hello-world' },
    };
    expect(disabled.projectEvent(textDelta)).toBe(textDelta);
    expect(disabledEvents).toBe(0);
    expect(disabledBodyBytes).toBe(0);
  });
});
