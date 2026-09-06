import { describe, expect, it, vi } from 'vitest';

import {
  countOpenFences,
  hasOpenFence,
  resolveStreamingRenderCadence,
  safeStreamingMarkdownText,
  segmentStreamingMarkdown,
  StreamingMarkdownPacer,
} from '@/lib/streamingMarkdown';

describe('streamingMarkdown', () => {
  it('uses 64ms markdown pace by default / iOS', () => {
    expect(resolveStreamingRenderCadence('ios').markdownPaceMs).toBe(64);
    expect(resolveStreamingRenderCadence('android').markdownPaceMs).toBe(128);
  });

  it('detects incomplete fences without throwing', () => {
    expect(hasOpenFence('```ts\nconst x = 1\n')).toBe(true);
    expect(hasOpenFence('```ts\nconst x = 1\n```')).toBe(false);
    expect(countOpenFences('hello\n```\ncode')).toBe(1);
    expect(countOpenFences('```\na\n```\n')).toBe(0);
  });

  it('isolates trailing open fence from stable content', () => {
    const segs = segmentStreamingMarkdown('Hello\n\n```js\nconsole.log(1)\n', true);
    expect(segs.length).toBe(2);
    expect(segs[0]?.openFence).toBe(false);
    expect(segs[0]?.raw).toContain('Hello');
    expect(segs[1]?.openFence).toBe(true);
    expect(() => safeStreamingMarkdownText('```\npartial', true)).not.toThrow();
  });

  it('paces publishes at markdown cadence', () => {
    vi.useFakeTimers();
    const published: string[] = [];
    const pacer = new StreamingMarkdownPacer(64, (t) => published.push(t));
    pacer.push('a');
    expect(published).toEqual(['a']);
    pacer.push('ab');
    pacer.push('abc');
    expect(published).toEqual(['a']);
    vi.advanceTimersByTime(64);
    expect(published.at(-1)).toBe('abc');
    pacer.dispose();
    vi.useRealTimers();
  });
});
