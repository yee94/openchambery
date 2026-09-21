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

  test('Markstream host keeps markdown-ready and turns off in-bubble node virtualization', () => {
    const source = readFileSync(join(here, 'MarkstreamRendererImpl.tsx'), 'utf8');
    const knobs = readFileSync(join(here, 'markstream/markstreamPerformance.ts'), 'utf8');
    expect(source).toContain('MARKSTREAM_CHAT_STREAM_PERFORMANCE');
    expect(source).toContain('data-markdown-ready="true"');
    expect(source).toContain('data-oc-markstream-virtual="off"');
    expect(knobs).toContain('maxLiveNodes: 0');
    expect(knobs).toContain('batchRendering: false');
    expect(knobs).toContain('smoothStreaming: false');
  });

  test('Markstream host CSS contains images to the OpenChamber max-width contract', () => {
    const theme = readFileSync(join(here, 'markstream/markstreamTheme.css'), 'utf8');
    const decorate = readFileSync(join(here, 'markdown/decorate.ts'), 'utf8');
    expect(decorate).toContain("'max-w-full'");
    expect(theme).toContain('.image-node__img');
    expect(theme).toContain('max-width: 100%');
    expect(theme).toContain('height: auto');
    expect(theme).toContain('object-fit: contain');
    expect(theme).toMatch(/\.image-node__img \{[\s\S]*max-width: 100%/);
  });

  test('Markstream wraps file path tokens during React render instead of after DOM commit', () => {
    const source = readFileSync(join(here, 'MarkstreamRendererImpl.tsx'), 'utf8');
    const fileRefs = readFileSync(join(here, 'markstream/markstreamFileReferences.tsx'), 'utf8');
    const custom = readFileSync(join(here, 'markstream/markstreamCustomComponents.ts'), 'utf8');
    expect(source).toContain('MarkstreamFileReferenceProvider');
    expect(source).toContain('enableFileReferences && !isStreaming');
    // One-shot registration owns text/inline_code/link/code_block (partial maps would wipe each other).
    expect(source).toContain("from './markstream/markstreamCustomComponents'");
    expect(source).toContain('ensureMarkstreamCustomComponents()');
    expect(fileRefs).toContain('splitParagraphPathTokens');
    expect(fileRefs).toContain('export function MarkstreamTextNode');
    expect(fileRefs).toContain('export function MarkstreamInlineCodeNode');
    expect(fileRefs).not.toContain('setCustomComponents');
    expect(fileRefs).not.toContain('MutationObserver');
    expect(fileRefs).not.toContain('wrapMarkdownFileReferenceTokens');
    expect(custom).toContain("setCustomComponents({");
    expect(custom).toContain('text: MarkstreamTextMapEntry');
    expect(custom).toContain("props.node?.type === 'code_block'");
    expect(custom).toContain('MarkstreamCodeBlockNode,');
    expect(custom).toContain('MarkstreamTextNode,');
    expect(custom).toContain('inline_code: MarkstreamInlineCodeNode');
    expect(custom).toContain('code_block:');
    expect(custom).toContain('withMarkstreamComponentDisplay(MarkstreamCodeBlockNode');
  });

  test('Markstream fenced code_block delegates to MarkdownRendererImpl chrome', () => {
    const source = readFileSync(join(here, 'MarkstreamRendererImpl.tsx'), 'utf8');
    const codeBlock = readFileSync(join(here, 'markstream/markstreamCodeBlock.tsx'), 'utf8');
    expect(source).toContain('MarkstreamHostContext.Provider');
    expect(source).not.toContain('codeBlockOptions');
    // Host already aligns library codeBlockStream with isStreaming; adapter does
    // not treat the library default as a proven blank root cause.
    expect(source).toContain('codeBlockStream={isStreaming}');
    expect(codeBlock).toContain('host.isStreaming');
    expect(codeBlock).not.toContain('props.stream');
    expect(codeBlock).toContain('markstreamCodeBlockMessageId');
    expect(codeBlock).toContain('partId: host.part?.id');
    expect(codeBlock).toContain('indexKey: props.indexKey');
    const messageIdHelper = readFileSync(join(here, 'markstream/markstreamCodeBlockMessageId.ts'), 'utf8');
    expect(messageIdHelper).toContain('export const markstreamCodeBlockMessageId');
    expect(messageIdHelper).toContain('part-${input.partId}');
    const fence = readFileSync(join(here, 'markstream/markstreamCodeBlockFence.ts'), 'utf8');
    expect(codeBlock).toContain("from '../MarkdownRendererImpl'");
    expect(codeBlock).toContain('MarkdownRenderer');
    expect(codeBlock).toContain('fenceMarkdownFromCodeBlockNode');
    expect(codeBlock).toContain('data-oc-markstream-code="markdown-impl"');
    expect(codeBlock).not.toContain("from '../MarkdownRenderer'");
    expect(fence).toContain('export const fenceMarkdownFromCodeBlockNode');
    expect(fence).toContain('isUsableCodeBlockFenceRaw');
    expect(fence).toContain('pickCodeBlockFenceMarker');
    // language may trim; raw must not (open-fence trailing whitespace is significant).
    expect(fence).not.toContain('node.raw.trim()');
    expect(fence).not.toMatch(/\braw\.trim\s*\(/);
  });

  test('Markstream lists and code match the previous OpenChamber markdown rhythm', () => {
    const theme = readFileSync(join(here, 'markstream/markstreamTheme.css'), 'utf8');
    expect(theme).toContain('padding-left: 18px');
    expect(theme).toContain('padding-left: 19px');
    expect(theme).toContain('padding-left: 1px');
    expect(theme).toContain('.list-item > .paragraph-node');
    expect(theme).toContain('font-size: var(--text-code)');
    expect(theme).toContain('.code-block-content');
    expect(theme).toContain('.oc-markstream-host.markdown-tool');
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
