import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  applyMarkdownCodeBlockWrapState,
  decorateMarkdown,
  type DecorateContext,
} from './decorate';

const directory = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(directory, '../../../index.css'), 'utf8');
const mobileCss = readFileSync(join(directory, '../../../styles/mobile.css'), 'utf8');

const context: DecorateContext = {
  labels: {
    copy: 'Copy',
    copied: 'Copied',
    enableCodeWrap: 'Enable wrap',
    disableCodeWrap: 'Disable wrap',
    copyDiagram: 'Copy diagram',
    downloadDiagram: 'Download diagram',
    zoomInDiagram: 'Zoom in',
    zoomOutDiagram: 'Zoom out',
    resetDiagramView: 'Reset view',
    previewLabel: 'Preview',
    previewTitle: 'Open preview',
  },
  mermaidControls: { copy: true, download: true, showPanZoomControls: true },
  codeBlockLineWrap: true,
  renderMermaid: () => ({}),
  imageTransportIdentity: 'test',
  imageEffectiveDirectory: '/workspace',
  imagePreviewEnabled: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mobile Markdown code block layout', () => {
  test('the rendered code surface preserves source and exposes an aria-hidden line-number gutter', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const root = document.createElement('div');
    const source = 'const longValue = "content";\n\nreturn longValue;\n';
    root.innerHTML = `<pre><code class="language-ts">${source}</code></pre>`;

    decorateMarkdown(root, context);
    applyMarkdownCodeBlockWrapState(root, true, context.labels);

    const wrapper = root.querySelector<HTMLElement>('[data-component="markdown-code"]');
    const body = wrapper?.querySelector<HTMLElement>('[data-md-code-body]');
    const gutter = body?.querySelector<HTMLElement>('[data-md-code-line-numbers]');
    expect(wrapper).not.toBeNull();
    expect(body).not.toBeNull();
    expect(gutter?.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper?.querySelector('code')?.textContent).toBe(source);
    expect(wrapper?.querySelector('[data-md-action="copy-code"]')).not.toBeNull();
    expect(wrapper?.querySelector('[data-md-action="toggle-code-wrap"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  test('applies the compact line-height token only to iOS WebKit mobile and Capacitor code blocks', () => {
    expect(indexCss).not.toMatch(
      /\[data-component=["']markdown-code["']\][^{]*\{[^}]*line-height:\s*var\(--markdown-code-block-line-height\)/s,
    );
    expect(mobileCss).toMatch(
      /@supports\s*\(-webkit-touch-callout:\s*none\)\s*\{[\s\S]*:root\.mobile-pointer:not\(\.desktop-runtime\)[^{]*\[data-component=["']markdown-code["']\][^{]*:root\.oc-capacitor-app[^{]*\[data-component=["']markdown-code["']\][^{]*\{[^}]*line-height:\s*var\(--markdown-code-block-line-height\)/s,
    );
  });

  test('hides the line-number gutter only for iOS WebKit mobile-pointer and iOS Capacitor surfaces', () => {
    const iosGutterRule = mobileCss.match(
      /@supports\s*\(-webkit-touch-callout:\s*none\)\s*\{\s*:root\.mobile-pointer:not\(\.desktop-runtime\)[^{]*\[data-md-code-line-numbers\],\s*:root\.oc-capacitor-app:not\(\.oc-platform-android\)[^{]*\[data-md-code-line-numbers\]\s*\{[^}]*display:\s*none;?\s*\}\s*\}/s,
    );

    expect(iosGutterRule).not.toBeNull();
    const cssWithoutIOSGutterRule = iosGutterRule
      ? mobileCss.replace(iosGutterRule[0], '')
      : mobileCss;
    expect(cssWithoutIOSGutterRule).not.toMatch(
      /\[data-md-code-line-numbers\](?:\[aria-hidden=["']true["']\])?\s*\{[^}]*display:\s*none/s,
    );
    expect(mobileCss).not.toMatch(
      /:root\.oc-capacitor-app\.oc-platform-android[^{]*\[data-md-code-line-numbers\][^{]*\{[^}]*display:\s*none/s,
    );
  });
});
