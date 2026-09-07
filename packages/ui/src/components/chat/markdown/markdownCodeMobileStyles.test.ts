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
const decorateSource = readFileSync(join(directory, 'decorate.ts'), 'utf8');
const injected = new Set<HTMLElement>();

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
  for (const node of injected) node.remove();
  injected.clear();
  document.documentElement.className = '';
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

  test('code cards clip without becoming overflow-hidden scrollport targets', () => {
    // LatticeOrb / ProgressiveGroup already document that mobile.css rewrites
    // .overflow-hidden → overflow-y:auto. Code cards sit inside every transcript
    // scroller (assistant contact + primary chat) and must not match that rewrite.
    expect(decorateSource).toContain("'my-4 group overflow-clip rounded-2xl border border-border/80 bg-[var(--surface-elevated)]'");
    expect(decorateSource).not.toMatch(
      /data-component['"]\s*,\s*['"]markdown-code['"][\s\S]{0,200}overflow-hidden rounded-2xl/,
    );
    expect(mobileCss).toContain('[data-component="markdown-code"]');
    expect(mobileCss).toContain('[data-md-code-body]');
    expect(mobileCss).not.toContain('.markdown-content .overflow-hidden');
  });

  test('mobile-pointer cascade keeps code cards as clippers and bodies as x-only scrollports', () => {
    document.documentElement.classList.add('mobile-pointer');
    const style = document.createElement('style');
    style.textContent = `
      .overflow-hidden { overflow: hidden; }
      /* happy-dom needs explicit longhands for the Tailwind shorthand. */
      .overflow-clip { overflow: clip; overflow-x: clip; overflow-y: clip; }
      .overflow-x-auto { overflow-x: auto; }
      .overflow-x-hidden { overflow-x: hidden; }
    ${mobileCss}`;
    document.head.appendChild(style);
    injected.add(style);

    const host = document.createElement('div');
    host.innerHTML = `
      <div class="markdown-content">
        <div data-component="markdown-code" class="overflow-hidden" data-testid="legacy-card"></div>
        <div data-component="markdown-code" class="overflow-clip" data-testid="clip-card"></div>
        <div data-md-code-body class="overflow-x-auto" data-testid="body"></div>
        <div data-md-code-body class="overflow-x-hidden" data-testid="wrapped-body"></div>
        <div data-component="generated-json-result" class="overflow-clip" data-testid="json-card"></div>
        <div class="overflow-hidden" style="max-height: 80px" data-testid="nested-scroll"></div>
      </div>
      <div class="overflow-hidden" data-testid="page-column"></div>
    `;
    document.body.appendChild(host);
    injected.add(host);

    // Regression baseline: bare overflow-hidden still becomes a page scrollport.
    expect(getComputedStyle(host.querySelector('[data-testid="page-column"]')!).overflowY).toBe('auto');
    // Named card shells retain clip semantics, including the legacy class.
    expect(getComputedStyle(host.querySelector('[data-testid="legacy-card"]')!).overflowY).toBe('clip');
    expect(getComputedStyle(host.querySelector('[data-testid="clip-card"]')!).overflowY).toBe('clip');
    expect(getComputedStyle(host.querySelector('[data-testid="json-card"]')!).overflowY).toBe('clip');
    expect(getComputedStyle(host.querySelector('[data-testid="nested-scroll"]')!).overflowY).toBe('auto');
    expect(getComputedStyle(host.querySelector('[data-testid="body"]')!).overflowX).toBe('auto');
    expect(getComputedStyle(host.querySelector('[data-testid="body"]')!).overflowY).toBe('hidden');
    expect(getComputedStyle(host.querySelector('[data-testid="wrapped-body"]')!).overflowX).toBe('hidden');
    expect(getComputedStyle(host.querySelector('[data-testid="wrapped-body"]')!).overflowY).toBe('hidden');
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
