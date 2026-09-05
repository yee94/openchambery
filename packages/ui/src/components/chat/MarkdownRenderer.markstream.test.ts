import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('markstream-react trial path', () => {
  test('MarkdownRenderer keeps the current renderer unless the store flag is on', () => {
    const source = readFileSync(join(here, 'MarkdownRenderer.tsx'), 'utf8');
    expect(source).toContain('markstreamReactEnabled');
    expect(source).toContain('MarkstreamRendererLazy');
    expect(source).toContain('MarkstreamFallbackBoundary');
    expect(source).toContain('if (!markstreamEnabled)');
    expect(source).toContain('currentRenderer');
  });

  test('SimpleMarkdownRenderer stays on the current implementation', () => {
    const source = readFileSync(join(here, 'MarkdownRenderer.tsx'), 'utf8');
    const simpleStart = source.indexOf('export const SimpleMarkdownRenderer');
    expect(simpleStart).toBeGreaterThan(0);
    expect(source.slice(simpleStart)).toContain('SimpleMarkdownRendererLazy');
    expect(source.slice(simpleStart)).not.toContain('MarkstreamRendererLazy');
  });

  test('preload also warms Markstream when the experiment default is on', () => {
    const source = readFileSync(join(here, 'markdownRendererLoader.ts'), 'utf8');
    expect(source).toContain('readMarkstreamReactEnabled()');
    expect(source).toContain('preloadMarkstreamRenderer()');
  });

  test('Markstream host keeps markdown-ready and in-document node virtualization', () => {
    const source = readFileSync(join(here, 'MarkstreamRendererImpl.tsx'), 'utf8');
    expect(source).toContain('MARKSTREAM_CHAT_STREAM_PERFORMANCE');
    expect(source).toContain('data-markdown-ready="true"');
    expect(source).toContain('data-oc-markstream-virtual="nodes"');
    expect(source).not.toContain('maxLiveNodes={0}');
  });
});
