import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));

vi.mock('@/contexts/useThemeSystem', () => ({
  useOptionalThemeSystem: () => null,
}));

vi.mock('@/hooks/useEffectiveDirectory', () => ({
  useEffectiveDirectory: () => '/tmp/project',
}));

vi.mock('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({
    editor: undefined,
    runtime: { isVSCode: false },
  }),
}));

vi.mock('@/stores/useUIStore', () => {
  const state = {
    codeBlockLineWrap: false,
    setCodeBlockLineWrap: () => undefined,
    mermaidRenderingMode: 'svg' as const,
    openContextPreview: () => undefined,
  };
  return {
    useUIStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

vi.mock('@/lib/platform', () => ({
  getClientPlatform: () => 'web' as const,
}));

vi.mock('@/lib/runtimeSurface', () => ({
  isMobileSurfaceRuntime: () => false,
}));

import { MarkstreamRenderer } from './MarkstreamRendererImpl';

const FENCE = ['```typescript', 'const openChamber = 1', 'console.log(openChamber)', '```'].join('\n');
const FENCE_STREAM_TAIL = ['```typescript', 'const openChamber = 1', 'console.log(openChamber)', 'const next = 2', '```'].join('\n');
const FENCE_B = ['```typescript', 'const otherMessage = 9', '```'].join('\n');
const FENCE_UNCLOSED = ['```typescript', 'const openChamber = 1  '].join('\n');
const FENCE_TILDE_WITH_BACKTICKS = ['~~~~markdown', 'docs use ```code``` fences', '~~~~'].join('\n');
const TWO_SAME_LANG = [
  '```typescript',
  'const first = 1',
  '```',
  '',
  '```typescript',
  'const second = 2',
  '```',
].join('\n');

describe('MarkstreamRenderer fenced code blocks (OpenChamber chrome)', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
  });

  const render = async (props: Partial<React.ComponentProps<typeof MarkstreamRenderer>> & { content: string }) => {
    await act(async () => {
      root.render(
        React.createElement(MarkstreamRenderer, {
          messageId: 'msg-code-regression',
          isAnimated: false,
          skipFadeIn: true,
          enableFileReferences: false,
          ...props,
        }),
      );
    });
    // Allow nested MarkdownRenderer layout + async morph commit.
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const flush = async (ms = 40) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  const codeText = () => container.querySelector('[data-component="markdown-code"]')?.textContent ?? '';
  const allCodeText = () =>
    Array.from(container.querySelectorAll('[data-component="markdown-code"]'))
      .map((node) => node.textContent ?? '')
      .join('\n');
  const codeHostIds = () =>
    Array.from(container.querySelectorAll('[data-oc-markstream-code-id]'))
      .map((node) => node.getAttribute('data-oc-markstream-code-id') ?? '');

  test('uses OpenChamber markdown-code chrome, not markstream default toolbar, and keeps source text', async () => {
    await render({ content: `Before\n\n${FENCE}\n\nAfter` });
    await flush(120);

    const host = container.querySelector('[data-oc-markdown-engine="markstream"]');
    expect(host).toBeTruthy();
    expect(container.querySelector('[data-oc-markstream-code="markdown-impl"]')).toBeTruthy();

    const ocCode = container.querySelector('[data-component="markdown-code"]');
    expect(ocCode).toBeTruthy();
    expect(codeText()).toContain('const openChamber = 1');
    expect(codeText()).toContain('console.log(openChamber)');

    // Library default CodeBlockNode chrome (large multi-control toolbar).
    expect(container.querySelector('.code-block-header')).toBeNull();
    expect(container.querySelector('.code-block-actions')).toBeNull();
    expect(container.querySelector('[class*="code-block-toolbar"]')).toBeNull();
  });

  test('survives unmount and remount without blanking the fence body', async () => {
    await render({ content: FENCE });
    await flush(120);
    expect(codeText()).toContain('openChamber');

    await act(async () => {
      root.render(null);
    });
    await flush(10);
    expect(container.querySelector('[data-component="markdown-code"]')).toBeNull();

    await render({ content: FENCE, messageId: 'msg-code-regression-remount' });
    await flush(120);

    const remounted = container.querySelector('[data-component="markdown-code"]');
    expect(remounted).toBeTruthy();
    expect(codeText()).toContain('const openChamber = 1');
    expect(codeText()).toContain('console.log(openChamber)');
    expect(codeText()).not.toMatch(/^\s*$/);
  });

  test('A→B→A with the same messageId/part returns the cached fence body', async () => {
    const partA = { id: 'part-stable-a', type: 'text', text: FENCE } as const;
    await render({
      content: FENCE,
      messageId: 'msg-code-stable',
      part: partA as never,
    });
    await flush(120);
    expect(codeText()).toContain('const openChamber = 1');
    const hostIdA = codeHostIds()[0];
    expect(hostIdA).toContain('msg-code-stable');
    expect(hostIdA).toContain('part-part-stable-a');

    await render({
      content: FENCE_B,
      messageId: 'msg-code-other',
      part: { id: 'part-other', type: 'text', text: FENCE_B } as never,
    });
    await flush(120);
    expect(codeText()).toContain('const otherMessage = 9');
    expect(codeText()).not.toContain('const openChamber = 1');

    await render({
      content: FENCE,
      messageId: 'msg-code-stable',
      part: partA as never,
    });
    await flush(120);
    expect(codeText()).toContain('const openChamber = 1');
    expect(codeText()).toContain('console.log(openChamber)');
    expect(codeText()).not.toMatch(/^\s*$/);
    expect(codeHostIds()[0]).toBe(hostIdA);
  });

  test('stream updates grow the fence body through the OpenChamber renderer', async () => {
    await render({ content: FENCE, isStreaming: true });
    await flush(120);
    expect(codeText()).toContain('openChamber');

    await render({ content: FENCE_STREAM_TAIL, isStreaming: true });
    await flush(120);
    expect(codeText()).toContain('const next = 2');

    await render({ content: FENCE_STREAM_TAIL, isStreaming: false });
    await flush(120);
    expect(codeText()).toContain('const next = 2');
    expect(codeText()).toContain('console.log(openChamber)');
  });

  test('unclosed streaming fence keeps body text through close', async () => {
    await render({ content: FENCE_UNCLOSED, isStreaming: true });
    await flush(120);
    expect(codeText()).toContain('const openChamber = 1');

    await render({ content: FENCE, isStreaming: false });
    await flush(120);
    expect(codeText()).toContain('const openChamber = 1');
    expect(codeText()).toContain('console.log(openChamber)');
  });

  test('tilde fence with embedded triple backticks keeps the body', async () => {
    await render({ content: FENCE_TILDE_WITH_BACKTICKS });
    await flush(120);
    expect(codeText()).toContain('docs use ```code``` fences');
  });

  test('two same-language fences get distinct host cache ids and both bodies', async () => {
    await render({ content: TWO_SAME_LANG, messageId: 'msg-multi-fence' });
    await flush(160);

    const ids = codeHostIds();
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('msg-multi-fence:'))).toBe(true);

    const text = allCodeText();
    expect(text).toContain('const first = 1');
    expect(text).toContain('const second = 2');
  });
});
