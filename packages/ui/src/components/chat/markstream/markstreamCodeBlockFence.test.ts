import { describe, expect, test } from 'vitest';
import {
  fenceMarkdownFromCodeBlockNode,
  isUsableCodeBlockFenceRaw,
  pickCodeBlockFenceMarker,
} from './markstreamCodeBlockFence';

describe('markstreamCodeBlockFence', () => {
  test('keeps usable backtick raw without trimming trailing body whitespace', () => {
    const raw = '```ts\nconst x = 1  \n';
    expect(isUsableCodeBlockFenceRaw(raw)).toBe(true);
    expect(fenceMarkdownFromCodeBlockNode({ raw, code: 'const x = 1  ', language: 'ts' })).toBe(raw);
  });

  test('keeps indented and longer-run fences and tilde markers as-is', () => {
    const indented = '  ````js\ncode\n````\n';
    expect(fenceMarkdownFromCodeBlockNode({ raw: indented, code: 'code', language: 'js' })).toBe(indented);

    const tilde = '~~~typescript\nconst a = 1\n~~~\n';
    expect(fenceMarkdownFromCodeBlockNode({ raw: tilde, code: 'const a = 1', language: 'typescript' })).toBe(tilde);
  });

  test('unclosed streaming raw keeps trailing whitespace (no trim)', () => {
    const raw = '```python\nprint("hi")   ';
    const out = fenceMarkdownFromCodeBlockNode({ raw, code: 'print("hi")   ', language: 'python' });
    expect(out.startsWith('```python\nprint("hi")   ')).toBe(true);
    expect(out).toContain('   \n');
  });

  test('rebuilds when raw is missing or not fence-shaped', () => {
    expect(fenceMarkdownFromCodeBlockNode({ code: 'a = 1', language: 'python' })).toBe(
      '```python\na = 1\n```\n',
    );
    expect(fenceMarkdownFromCodeBlockNode({ raw: 'not a fence', code: 'a = 1', language: 'python' })).toBe(
      '```python\na = 1\n```\n',
    );
  });

  test('keeps reconstructed loading fences open across incremental parser updates', () => {
    for (const raw of [undefined, 'const a = 1']) {
      expect(fenceMarkdownFromCodeBlockNode({ raw, code: 'const a = 1', language: 'ts', loading: true })).toBe(
        '```ts\nconst a = 1\n',
      );
    }
  });

  test('rebuild uses a fence longer than embedded triple backticks', () => {
    const code = 'example:\n```\ninner\n```\n';
    expect(pickCodeBlockFenceMarker(code)).toBe('````');
    const out = fenceMarkdownFromCodeBlockNode({ code, language: 'md' });
    expect(out.startsWith('````md\n')).toBe(true);
    expect(out.endsWith('````\n')).toBe(true);
    expect(out).toContain('```\ninner\n```');
  });

  test('tilde raw with embedded triple backticks is preserved', () => {
    const raw = '~~~~markdown\nUse ```code``` inline\n~~~~\n';
    expect(fenceMarkdownFromCodeBlockNode({
      raw,
      code: 'Use ```code``` inline',
      language: 'markdown',
    })).toBe(raw);
  });
});
