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

  test('Markstream last node-slot drops trailing paragraph margin so the process fold stays tight', () => {
    const theme = readFileSync(join(here, 'markstream/markstreamTheme.css'), 'utf8');
    const indexCss = readFileSync(join(here, '../../index.css'), 'utf8');
    const fold = readFileSync(join(here, 'message/parts/ContextToolGroup.tsx'), 'utf8');
    expect(theme).toContain('.node-slot:last-of-type .paragraph-node');
    expect(theme).toContain('margin-bottom: 0');
    expect(indexCss).toContain('.oc-markstream-host .markstream-react > .node-slot:last-of-type p');
    expect(fold).toContain('getToolRowBlockClass(isMobile)');
    expect(fold).not.toMatch(/className=\{getToolRowBlockClass[\s\S]*\bmt-/);
  });
});
