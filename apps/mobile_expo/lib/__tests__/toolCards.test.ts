import { describe, expect, it } from 'vitest';

import type { ChatMessagePart } from '@/lib/sessionMessages';
import {
  isToolPartSettled,
  mergeLivePart,
  normalizeToolName,
  reasoningFromPart,
  reasoningSummary,
  segmentsFromParts,
  toolCardFromPart,
  toolDisplayName,
  toolShortDescription,
} from '@/lib/toolCards';

describe('normalizeToolName / display', () => {
  it('strips runtime prefix and index', () => {
    expect(normalizeToolName('runtime.grep:3')).toBe('grep');
    expect(toolDisplayName('runtime.grep:3')).toBe('Search Files');
    expect(toolDisplayName('bash')).toBe('Run');
  });
});

describe('toolCardFromPart', () => {
  it('builds expandable card from Cap-shaped tool part', () => {
    const part: ChatMessagePart = {
      id: 'p1',
      type: 'tool',
      tool: 'read',
      state: {
        status: 'completed',
        input: { filePath: '/repo/apps/mobile_expo/App.tsx' },
        output: 'file contents here',
        time: { start: 1, end: 2 },
      },
    };
    const card = toolCardFromPart(part, 0);
    expect(card).toMatchObject({
      id: 'p1',
      displayName: 'Read File',
      status: 'completed',
      settled: true,
      description: 'App.tsx',
      output: 'file contents here',
    });
    expect(isToolPartSettled(part)).toBe(true);
  });

  it('marks running tools unsettled', () => {
    const part: ChatMessagePart = {
      id: 'p2',
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'running',
        input: { command: 'ls -la' },
      },
    };
    const card = toolCardFromPart(part, 1);
    expect(card?.status).toBe('running');
    expect(card?.settled).toBe(false);
    expect(toolShortDescription(part)).toBe('ls -la');
  });
});

describe('reasoning disclosure helpers', () => {
  it('summarizes and auto-streams', () => {
    const part: ChatMessagePart = {
      id: 'r1',
      type: 'reasoning',
      text: '> thinking about the **path** to fix\n\nmore detail here that is longer than eighty characters for the summary cut',
    };
    const model = reasoningFromPart(part, 0);
    expect(model?.streaming).toBe(true);
    expect(model?.summary.length).toBeLessThanOrEqual(81);
    expect(reasoningSummary('short')).toBe('short');
  });

  it('settles when time.end present', () => {
    const part: ChatMessagePart = {
      id: 'r2',
      type: 'reasoning',
      text: 'done thinking',
      time: { start: 1, end: 2 },
    };
    expect(reasoningFromPart(part, 0)?.streaming).toBe(false);
  });
});

describe('segmentsFromParts', () => {
  it('orders reasoning, tools, and text like Cap MessageBody subset', () => {
    const parts: ChatMessagePart[] = [
      { id: 'r', type: 'reasoning', text: 'think' },
      {
        id: 't',
        type: 'tool',
        tool: 'grep',
        state: { status: 'completed', input: { pattern: 'foo' }, output: '1 match' },
      },
      { id: 'x', type: 'text', text: 'answer' },
    ];
    const segments = segmentsFromParts(parts);
    expect(segments.map((s) => s.kind)).toEqual(['reasoning', 'tool', 'text']);
    expect(segments[1]).toMatchObject({ kind: 'tool', card: { description: 'foo' } });
  });
});

describe('mergeLivePart', () => {
  it('replaces by id', () => {
    const parts: ChatMessagePart[] = [{ id: 't', type: 'tool', tool: 'read', state: { status: 'running' } }];
    const next = mergeLivePart(parts, {
      id: 't',
      type: 'tool',
      tool: 'read',
      state: { status: 'completed', output: 'ok' },
    });
    expect(next).toHaveLength(1);
    expect((next[0]?.state as { status?: string }).status).toBe('completed');
  });
});
