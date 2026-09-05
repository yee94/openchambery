import { copyTextToClipboard } from '@/lib/clipboard';
import { getExternalFaviconUrl, isExternalHttpUrl, isLoopbackHttpUrl } from '@/lib/url';
import type { IconName } from '@/components/icon/icons';
import { parseCodeFenceInfo } from './codeFenceInfo';
import { getMermaidViewerController } from './mermaidViewer';
import { needsRuntimeImageStream, resolveImageSource } from '../imageSource';
import { wrapMarkdownFileReferenceTokens } from '../fileReferenceDecorate';

// ---------------------------------------------------------------------------
// Shared decoration context
// ---------------------------------------------------------------------------

export type MermaidRender = { svg?: string; ascii?: string };

export type DecorateLabels = {
  copy: string;
  copied: string;
  enableCodeWrap: string;
  disableCodeWrap: string;
  copyDiagram: string;
  downloadDiagram: string;
  zoomInDiagram: string;
  zoomOutDiagram: string;
  resetDiagramView: string;
  previewLabel: string;
  previewTitle: string;
};

export type MermaidControlOptions = {
  download: boolean;
  copy: boolean;
  showPanZoomControls: boolean;
};

export type DecorateContext = {
  labels: DecorateLabels;
  mermaidControls: MermaidControlOptions;
  codeBlockLineWrap: boolean;
  deferCodeLineNumberSync?: boolean;
  onToggleCodeBlockLineWrap?: () => void;
  // Renders a mermaid block source to svg/ascii using current theme colors.
  renderMermaid: (source: string) => MermaidRender;
  onPreviewLoopback?: (url: string) => void;
  imageTransportIdentity: string;
  imageEffectiveDirectory: string;
  imagePreviewEnabled: boolean;
};

// Reference the app's icon sprite (injected into <body> by the shared Icon
// component) so DOM-built controls use the same themed icons as the rest of
// the app. Sprite symbols are registered under `#oc-<name>`.
const spriteIcon = (name: IconName, className = 'size-3.5'): string =>
  `<svg class="oc-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#oc-${name}"></use></svg>`;

const ICONS = {
  copy: spriteIcon('file-copy'),
  check: spriteIcon('check'),
  download: spriteIcon('download'),
  zoomIn: spriteIcon('add'),
  zoomOut: spriteIcon('subtract'),
  fit: spriteIcon('refresh'),
  textWrap: spriteIcon('text-wrap'),
  image: spriteIcon('file-image', 'size-10'),
  imageDownload: spriteIcon('download', 'size-3'),
  imageLoading: spriteIcon('loader-4', 'size-3.5 animate-spin motion-reduce:animate-none'),
} as const;

const ICON_BTN_CLASS =
  'p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--interactive-focus-ring)]';

const setIconHtml = (el: Element, html: string): void => {
  el.innerHTML = html;
};

const makeIconButton = (icon: keyof typeof ICONS, title: string, slot: string): HTMLButtonElement => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ICON_BTN_CLASS;
  button.setAttribute('data-md-action', slot);
  button.setAttribute('title', title);
  button.setAttribute('aria-label', title);
  setIconHtml(button, ICONS[icon]);
  return button;
};

const applyCodeBlockWrapState = (wrapper: HTMLElement, enabled: boolean, labels: DecorateLabels): void => {
  const body = wrapper.querySelector<HTMLElement>('[data-md-code-body]');
  const pre = wrapper.querySelector<HTMLElement>('pre');
  const code = wrapper.querySelector<HTMLElement>('pre code');
  const wrapButton = wrapper.querySelector<HTMLButtonElement>('[data-md-action="toggle-code-wrap"]');
  wrapper.setAttribute('data-code-wrap', enabled ? 'true' : 'false');
  body?.classList.toggle('overflow-x-auto', !enabled);
  body?.classList.toggle('overflow-x-hidden', enabled);
  pre?.classList.toggle('whitespace-pre-wrap', enabled);
  pre?.classList.toggle('break-words', enabled);
  code?.classList.toggle('whitespace-pre-wrap', enabled);
  code?.classList.toggle('break-words', enabled);
  if (pre) {
    pre.style.whiteSpace = enabled ? 'pre-wrap' : 'pre';
    pre.style.overflowWrap = enabled ? 'anywhere' : 'normal';
  }
  if (code) {
    code.style.whiteSpace = enabled ? 'pre-wrap' : 'pre';
    code.style.overflowWrap = enabled ? 'anywhere' : 'normal';
  }
  if (wrapButton) {
    const title = enabled ? labels.disableCodeWrap : labels.enableCodeWrap;
    wrapButton.setAttribute('title', title);
    wrapButton.setAttribute('aria-label', title);
    wrapButton.classList.toggle('text-foreground', enabled);
    wrapButton.classList.toggle('opacity-100', enabled);
    wrapButton.classList.toggle('text-muted-foreground', !enabled);
    wrapButton.classList.toggle('opacity-65', !enabled);
    wrapButton.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  }
};

const createCodeLineNumbers = (pre: HTMLPreElement): HTMLDivElement => {
  const gutter = document.createElement('div');
  gutter.setAttribute('data-md-code-line-numbers', '');
  gutter.setAttribute('aria-hidden', 'true');
  gutter.className = 'min-w-8 shrink-0 select-none border-r border-border/50 pr-3 text-right font-mono text-[13px] text-muted-foreground/45';

  const text = pre.textContent ?? '';
  const lineCount = Math.max(1, text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length);
  for (let index = 1; index <= lineCount; index += 1) {
    const line = document.createElement('div');
    line.className = 'tabular-nums';
    line.textContent = String(index);
    gutter.appendChild(line);
  }

  return gutter;
};

const collectTextNodes = (root: HTMLElement): Text[] => {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
};

const findTextPosition = (nodes: Text[], targetOffset: number): { node: Text; offset: number } | null => {
  let offset = 0;
  for (const node of nodes) {
    const nextOffset = offset + node.data.length;
    if (targetOffset <= nextOffset) {
      return { node, offset: Math.max(0, targetOffset - offset) };
    }
    offset = nextOffset;
  }
  const last = nodes.at(-1);
  return last ? { node: last, offset: last.data.length } : null;
};

type LineBox = { top: number; bottom: number; width: number; height: number };

// WebKit (iOS) often reports a wrapped line as one tall client rect instead of
// N row tops. Counting unique tops then treats that line as a single row and
// the gutter walks off the wrapped code. Use the union height instead.
export const heightFromLineRects = (
  rects: ArrayLike<LineBox>,
  lineHeight: number,
): number => {
  let top = Infinity;
  let bottom = -Infinity;
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (!rect || (rect.width === 0 && rect.height === 0)) continue;
    if (rect.top < top) top = rect.top;
    if (rect.bottom > bottom) bottom = rect.bottom;
  }
  if (!Number.isFinite(top) || bottom <= top) return lineHeight;
  return Math.max(lineHeight, bottom - top);
};

const collectShikiLineSpans = (code: HTMLElement): HTMLElement[] =>
  Array.from(code.children).filter((node): node is HTMLElement => (
    node instanceof HTMLElement && node.classList.contains('line')
  ));

const applyLineNumberSize = (lineEl: HTMLElement, height: number, lineHeight: number): void => {
  lineEl.style.height = `${height}px`;
  lineEl.style.lineHeight = `${lineHeight}px`;
};

const measureRangeLineHeight = (
  start: { node: Text; offset: number },
  end: { node: Text; offset: number },
  lineHeight: number,
): number => {
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const height = Math.max(
    heightFromLineRects(range.getClientRects(), lineHeight),
    heightFromLineRects([range.getBoundingClientRect()], lineHeight),
  );
  range.detach();
  return height;
};

export const syncMarkdownCodeLineNumbers = (root: HTMLElement): void => {
  const wrappers = root.querySelectorAll<HTMLElement>('[data-component="markdown-code"]');
  for (const wrapper of Array.from(wrappers)) {
    const code = wrapper.querySelector<HTMLElement>('pre code');
    const gutter = wrapper.querySelector<HTMLElement>('[data-md-code-line-numbers]');
    if (!code || !gutter) continue;

    const numbers = Array.from(gutter.children) as HTMLElement[];
    const codeStyle = window.getComputedStyle(code);
    const lineHeight = Number.parseFloat(codeStyle.lineHeight) || 20;
    gutter.style.fontFamily = codeStyle.fontFamily;
    gutter.style.fontSize = codeStyle.fontSize;
    gutter.style.lineHeight = `${lineHeight}px`;

    // Shiki emits one `.line` span per logical line. Adjacent tops already
    // include wrap, so this stays aligned even when Range client rects collapse.
    const lineSpans = collectShikiLineSpans(code);
    if (lineSpans.length === numbers.length) {
      const spanRects = lineSpans.map((el) => el.getBoundingClientRect());
      const isEmptyShikiLine = (span: HTMLElement | undefined): boolean =>
        (span?.textContent ?? '').length === 0;
      for (let index = 0; index < numbers.length; index += 1) {
        const lineEl = numbers[index];
        const span = lineSpans[index];
        const current = spanRects[index];
        if (!lineEl || !span || !current) continue;
        // Empty `.line` rects often collapse (WebKit origin/zero). Never let them
        // drive adjacent top-diff — assign one row and measure neighbors from
        // their own box bottom instead of the empty span's top.
        if (isEmptyShikiLine(span)) {
          applyLineNumberSize(lineEl, lineHeight, lineHeight);
          continue;
        }
        const nextSpan = lineSpans[index + 1];
        const next = spanRects[index + 1];
        const bottom = next && !isEmptyShikiLine(nextSpan)
          ? next.top
          : current.bottom;
        applyLineNumberSize(
          lineEl,
          heightFromLineRects([{
            top: current.top,
            bottom,
            width: 1,
            height: bottom - current.top,
          }], lineHeight),
          lineHeight,
        );
      }
      continue;
    }

    const text = code.textContent ?? '';
    const textNodes = collectTextNodes(code);
    let lineStart = 0;

    for (let index = 0; index < numbers.length; index += 1) {
      const nextBreak = text.indexOf('\n', lineStart);
      const lineEnd = nextBreak === -1 ? text.length : nextBreak;
      const lineEl = numbers[index];
      if (!lineEl) continue;

      const start = findTextPosition(textNodes, lineStart);
      const end = findTextPosition(textNodes, lineEnd);
      if (!start || !end || lineStart === lineEnd) {
        applyLineNumberSize(lineEl, lineHeight, lineHeight);
      } else {
        applyLineNumberSize(lineEl, measureRangeLineHeight(start, end, lineHeight), lineHeight);
      }

      lineStart = lineEnd + 1;
    }
  }
};

export const scheduleMarkdownCodeLineNumberSync = (root: HTMLElement): void => {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => syncMarkdownCodeLineNumbers(root));
  });
};

export const applyMarkdownCodeBlockWrapState = (root: HTMLElement, enabled: boolean, labels: DecorateLabels): void => {
  const wrappers = root.querySelectorAll<HTMLElement>('[data-component="markdown-code"]');
  for (const wrapper of Array.from(wrappers)) {
    const body = wrapper.querySelector<HTMLElement>('[data-md-code-body]');
    const pre = wrapper.querySelector<HTMLPreElement>('pre');
    if (body && pre && !body.querySelector('[data-md-code-line-numbers]')) {
      body.classList.add('flex', 'gap-3');
      body.insertBefore(createCodeLineNumbers(pre), pre);
    }
    applyCodeBlockWrapState(wrapper, enabled, labels);
  }
  scheduleMarkdownCodeLineNumberSync(root);
};

const flashCopied = (button: HTMLButtonElement, copiedTitle: string, restore: keyof typeof ICONS, restoreTitle: string): void => {
  setIconHtml(button, ICONS.check);
  button.setAttribute('title', copiedTitle);
  button.setAttribute('aria-label', copiedTitle);
  window.setTimeout(() => {
    setIconHtml(button, ICONS[restore]);
    button.setAttribute('title', restoreTitle);
    button.setAttribute('aria-label', restoreTitle);
  }, 2000);
};

// ---------------------------------------------------------------------------
// Code blocks: inline-code marker + copy button wrapper
// ---------------------------------------------------------------------------

const decorateInlineCode = (root: HTMLElement): void => {
  const inline = root.querySelectorAll<HTMLElement>(':not(pre) > code');
  for (const code of Array.from(inline)) {
    if (code.getAttribute('data-markdown') !== 'inline-code') {
      code.setAttribute('data-markdown', 'inline-code');
    }
  }
};

const decorateCodeBlocks = (root: HTMLElement, ctx: DecorateContext): void => {
  const blocks = root.querySelectorAll<HTMLPreElement>('pre');
  for (const pre of Array.from(blocks)) {
    // Skip mermaid placeholders (handled separately).
    if (pre.querySelector('code.language-mermaid')) continue;
    const parent = pre.parentElement;
    if (!parent) continue;
    // Already wrapped (idempotent across morphdom passes).
    if (parent.closest('[data-component="markdown-code"]')) continue;

    // The label attributes are stamped by the async highlight pass; on the
    // synchronous first paint they aren't set yet, so fall back to parsing the
    // `language-*` class marked emits — keeps the card header label stable
    // instead of flashing 'text'.
    const classInfo = pre.querySelector('code')?.className.match(/language-([^\s"]+)/)?.[1];
    const label = pre.getAttribute('data-md-label')
      ?? pre.getAttribute('data-md-lang')
      ?? parseCodeFenceInfo(classInfo).label;

    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-component', 'markdown-code');
    wrapper.className =
      'my-4 group overflow-hidden rounded-2xl border border-border/80 bg-[var(--surface-elevated)]';

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between border-b border-border/70 px-3 py-1.5';
    const langLabel = document.createElement('span');
    langLabel.className = 'font-mono text-[13px] text-muted-foreground';
    langLabel.textContent = label;
    const copyBtn = makeIconButton('copy', ctx.labels.copy, 'copy-code');
    const wrapBtn = makeIconButton('textWrap', ctx.codeBlockLineWrap ? ctx.labels.disableCodeWrap : ctx.labels.enableCodeWrap, 'toggle-code-wrap');
    header.appendChild(langLabel);
    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-1';
    actions.appendChild(wrapBtn);
    actions.appendChild(copyBtn);
    header.appendChild(actions);

    const body = document.createElement('div');
    body.setAttribute('data-md-code-body', '');
    // The gutter is never inlined here — `applyMarkdownCodeBlockWrapState` adds
    // it once the content settles. Keeping the decorated HTML independent of
    // `deferCodeLineNumberSync` means a stream ending does not change what
    // decorate produces, so every already-painted code block morphs to itself
    // instead of being rebuilt at the moment the turn completes.
    body.className = 'px-3 py-2.5 overflow-x-auto';

    parent.replaceChild(wrapper, pre);
    pre.style.margin = '0';
    pre.style.background = 'transparent';
    pre.classList.add('min-w-0', 'w-full', 'flex-1');
    body.appendChild(pre);
    wrapper.appendChild(header);
    wrapper.appendChild(body);
    applyCodeBlockWrapState(wrapper, ctx.codeBlockLineWrap, ctx.labels);
  }
};

// ---------------------------------------------------------------------------
// Tables: wrapper + horizontal scrolling
// ---------------------------------------------------------------------------
const decorateTables = (root: HTMLElement): void => {
  const tables = root.querySelectorAll<HTMLTableElement>('table');
  for (const table of Array.from(tables)) {
    const existing = table.closest('[data-markdown="table-wrapper"]');
    if (existing) continue;

    const wrapper = document.createElement('div');
    // Layout chrome lives in index.css / mobile.css via data-markdown hooks so
    // wide tables can grow beyond the message column and scroll horizontally.
    wrapper.className = 'my-4';
    wrapper.setAttribute('data-markdown', 'table-wrapper');

    const scroll = document.createElement('div');
    scroll.setAttribute('data-markdown', 'table-scroll');

    const parent = table.parentElement;
    if (!parent) continue;
    parent.replaceChild(wrapper, table);
    table.setAttribute('data-markdown', 'table');

    for (const tr of Array.from(table.querySelectorAll('tr'))) {
      tr.setAttribute('data-markdown', 'table-row');
    }
    for (const th of Array.from(table.querySelectorAll('th'))) {
      th.setAttribute('data-markdown', 'table-header-cell');
    }
    for (const td of Array.from(table.querySelectorAll('td'))) {
      td.setAttribute('data-markdown', 'table-cell');
    }

    scroll.appendChild(table);
    wrapper.appendChild(scroll);
  }
};

// ---------------------------------------------------------------------------
// Mermaid: replace ```mermaid code fences with rendered diagram blocks
// ---------------------------------------------------------------------------

const decorateMermaid = (root: HTMLElement, ctx: DecorateContext): void => {
  const codes = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
  for (const code of Array.from(codes)) {
    const pre = code.parentElement as HTMLPreElement | null;
    if (!pre) continue;
    const source = (code.textContent ?? '').replace(/\s+$/, '');
    const rendered = ctx.renderMermaid(source);

    const block = document.createElement('div');
    block.setAttribute('data-markdown', 'mermaid-block');
    block.setAttribute('data-md-source', source);
    block.className = 'group relative';

    const scroll = document.createElement('div');
    scroll.setAttribute('data-markdown', 'mermaid-scroll');

    const toolbar = document.createElement('div');
    toolbar.setAttribute('data-markdown', 'mermaid-toolbar');
    toolbar.className = 'absolute top-1 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity';

    if (rendered.svg) {
      block.setAttribute('data-mermaid-render', 'svg');
      const viewport = document.createElement('div');
      viewport.setAttribute('data-markdown', 'mermaid-viewport');
      const svgHost = document.createElement('div');
      svgHost.setAttribute('data-markdown', 'mermaid');
      svgHost.setAttribute('data-md-original-svg', rendered.svg);
      svgHost.innerHTML = rendered.svg;
      viewport.appendChild(svgHost);
      scroll.appendChild(viewport);
      if (ctx.mermaidControls.showPanZoomControls) {
        toolbar.appendChild(makeIconButton('zoomIn', ctx.labels.zoomInDiagram, 'mermaid-zoom-in'));
        toolbar.appendChild(makeIconButton('zoomOut', ctx.labels.zoomOutDiagram, 'mermaid-zoom-out'));
        toolbar.appendChild(makeIconButton('fit', ctx.labels.resetDiagramView, 'mermaid-fit'));
      }
      if (ctx.mermaidControls.copy) {
        const copy = makeIconButton('copy', ctx.labels.copyDiagram, 'mermaid-copy');
        copy.setAttribute('data-md-source', source);
        toolbar.appendChild(copy);
      }
      if (ctx.mermaidControls.download) {
        const download = makeIconButton('download', ctx.labels.downloadDiagram, 'mermaid-download');
        download.setAttribute('data-md-svg', '1');
        toolbar.appendChild(download);
      }
    } else {
      block.setAttribute('data-mermaid-render', 'ascii');
      const asciiPre = document.createElement('pre');
      asciiPre.setAttribute('data-markdown', 'mermaid-ascii');
      asciiPre.textContent = rendered.ascii || source;
      scroll.appendChild(asciiPre);
      if (ctx.mermaidControls.copy) {
        const copy = makeIconButton('copy', ctx.labels.copyDiagram, 'mermaid-copy');
        copy.setAttribute('data-md-source', rendered.ascii || source);
        toolbar.appendChild(copy);
      }
    }

    block.appendChild(scroll);
    block.appendChild(toolbar);

    const host = pre.parentElement;
    if (!host) continue;
    host.replaceChild(block, pre);
  }
};

// ---------------------------------------------------------------------------
// External links: favicon + loopback preview button
// ---------------------------------------------------------------------------

const decorateLinks = (root: HTMLElement, ctx: DecorateContext): void => {
  const anchors = root.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (const anchor of Array.from(anchors)) {
    if (anchor.getAttribute('data-md-link-decorated') === 'true') continue;
    if (anchor.getAttribute('data-openchamber-file-link') === 'true') continue;
    const href = anchor.getAttribute('href') ?? '';
    if (!isExternalHttpUrl(href)) continue;
    anchor.setAttribute('data-md-link-decorated', 'true');

    const faviconUrl = getExternalFaviconUrl(href);
    if (faviconUrl) {
      const favWrap = document.createElement('span');
      favWrap.className =
        'mr-1 inline-flex size-[18px] items-center justify-center rounded border border-[var(--border)] bg-[var(--interactive-hover)] align-middle';
      const img = document.createElement('img');
      img.setAttribute('data-md-link-favicon', 'true');
      img.src = faviconUrl;
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.className = 'size-3.5 rounded-sm';
      img.addEventListener('error', () => favWrap.remove(), { once: true });
      favWrap.appendChild(img);
      anchor.parentNode?.insertBefore(favWrap, anchor);
    }

    if (ctx.onPreviewLoopback && isLoopbackHttpUrl(href)) {
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = `ml-1 align-middle ${ICON_BTN_CLASS}`;
      preview.setAttribute('data-md-action', 'preview-loopback');
      preview.setAttribute('data-md-url', href);
      preview.setAttribute('title', ctx.labels.previewTitle);
      preview.setAttribute('aria-label', ctx.labels.previewLabel);
      setIconHtml(preview, ICONS.download);
      anchor.parentNode?.insertBefore(preview, anchor.nextSibling);
    }
  }
};

const MARKDOWN_IMAGE_SELECTOR = 'img:not([data-md-link-favicon="true"])';
const MARKDOWN_IMAGE_PRESENTATION_SELECTOR = '[data-md-image-presentation="true"]';
const MARKDOWN_IMAGE_PLACEHOLDER_SOURCE = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="576" height="324" viewBox="0 0 576 324"%3E%3C/svg%3E';
const MARKDOWN_IMAGE_CLASS = [
  'block',
  'max-w-full',
  'rounded-xl',
  'border',
  'border-border/80',
  'bg-[var(--surface-muted)]',
  'transition-colors',
  'focus-visible:outline',
  'focus-visible:outline-2',
  'focus-visible:outline-offset-2',
  'focus-visible:outline-[var(--interactive-focus-ring)]',
];
const MARKDOWN_IMAGE_INTERACTIVE_CLASS = ['cursor-pointer', 'hover:bg-interactive-hover/60'];
const MARKDOWN_IMAGE_PLACEHOLDER_CLASS = ['aspect-video', 'h-auto', 'w-full', 'max-w-xl', 'object-contain'];

const ensureMarkdownImagePresentation = (image: HTMLImageElement): HTMLElement => {
  const parent = image.parentElement;
  if (parent?.matches(MARKDOWN_IMAGE_PRESENTATION_SELECTOR)) {
    return parent;
  }

  const presentation = document.createElement('span');
  presentation.setAttribute('data-md-image-presentation', 'true');
  presentation.className = 'relative my-4 block w-fit max-w-full';

  const visual = document.createElement('span');
  visual.setAttribute('data-md-image-placeholder-visual', 'true');
  visual.setAttribute('aria-hidden', 'true');
  visual.className = 'pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground';

  const imageIcon = document.createElement('span');
  imageIcon.className = 'relative flex size-14 items-center justify-center rounded-2xl border border-border/80 bg-[var(--surface-elevated)] shadow-sm';
  setIconHtml(imageIcon, ICONS.image);

  const downloadBadge = document.createElement('span');
  downloadBadge.setAttribute('data-md-image-download-badge', 'true');
  downloadBadge.className = 'absolute -right-1.5 -bottom-1.5 flex size-6 items-center justify-center rounded-full border border-border bg-[var(--surface-elevated)] text-foreground shadow-sm';
  setIconHtml(downloadBadge, ICONS.imageDownload);

  const loadingBadge = document.createElement('span');
  loadingBadge.setAttribute('data-md-image-loading-badge', 'true');
  loadingBadge.className = 'absolute -right-1.5 -bottom-1.5 hidden size-6 items-center justify-center rounded-full border border-border bg-[var(--surface-elevated)] text-foreground shadow-sm';
  setIconHtml(loadingBadge, ICONS.imageLoading);

  imageIcon.appendChild(downloadBadge);
  imageIcon.appendChild(loadingBadge);
  visual.appendChild(imageIcon);
  parent?.replaceChild(presentation, image);
  presentation.appendChild(image);
  presentation.appendChild(visual);
  return presentation;
};

export const setMarkdownImagePlaceholder = (image: HTMLImageElement): void => {
  image.src = MARKDOWN_IMAGE_PLACEHOLDER_SOURCE;
  image.setAttribute('data-md-placeholder-source', MARKDOWN_IMAGE_PLACEHOLDER_SOURCE);
  image.setAttribute('data-md-image-state', 'placeholder');
  image.classList.add(...MARKDOWN_IMAGE_PLACEHOLDER_CLASS);
};

export const clearMarkdownImagePlaceholder = (image: HTMLImageElement): void => {
  image.removeAttribute('data-md-image-state');
  image.removeAttribute('data-md-placeholder-source');
  image.removeAttribute('aria-busy');
  image.classList.remove(...MARKDOWN_IMAGE_PLACEHOLDER_CLASS);
};

export const decorateMarkdownImages = (root: HTMLElement, ctx: DecorateContext): void => {
  if (!ctx.imagePreviewEnabled) {
    return;
  }

  const images = root.querySelectorAll<HTMLImageElement>(MARKDOWN_IMAGE_SELECTOR);
  for (const image of Array.from(images)) {
    const source = image.getAttribute('data-md-image-source') ?? image.getAttribute('src') ?? '';
    const resolved = resolveImageSource(source, ctx.imageEffectiveDirectory);
    // Only host/runtime file paths need placeholders + streamed display URLs.
    // Browser-native http(s)/data/blob sources keep the direct img path.
    if (!needsRuntimeImageStream(resolved)) continue;

    image.classList.add(...MARKDOWN_IMAGE_CLASS, ...MARKDOWN_IMAGE_INTERACTIVE_CLASS);
    image.setAttribute('role', 'button');
    image.setAttribute('tabindex', '0');
    image.setAttribute('data-md-image-source', source);
    ensureMarkdownImagePresentation(image);
    setMarkdownImagePlaceholder(image);
  }
};

/** Run all idempotent DOM decoration passes over freshly-rendered markdown. */
export const decorateMarkdown = (root: HTMLElement, ctx: DecorateContext): void => {
  decorateInlineCode(root);
  decorateMermaid(root, ctx);
  decorateCodeBlocks(root, ctx);
  decorateTables(root);
  decorateLinks(root, ctx);
  decorateMarkdownImages(root, ctx);
  wrapMarkdownFileReferenceTokens(root);
};

// ---------------------------------------------------------------------------
// Delegated interactions (copy/download/menus/preview)
// ---------------------------------------------------------------------------

const downloadBlob = (filename: string, content: string, mime: string): void => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Attach a single delegated click listener for all in-markdown actions: code
 * and mermaid copy/download, plus loopback preview.
 * Returns a cleanup function.
 */
export const attachMarkdownInteractions = (
  container: HTMLElement,
  ctx: DecorateContext,
): (() => void) => {
  const handleClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const actionEl = target.closest<HTMLElement>('[data-md-action]');
    if (!actionEl) {
      return;
    }
    const action = actionEl.getAttribute('data-md-action') ?? '';

    // Copy code
    if (action === 'copy-code') {
      const code = actionEl.closest('[data-component="markdown-code"]')?.querySelector('code');
      const text = code?.textContent ?? '';
      if (text) void copyTextToClipboard(text).then(() => flashCopied(actionEl as HTMLButtonElement, ctx.labels.copied, 'copy', ctx.labels.copy));
      return;
    }

    if (action === 'toggle-code-wrap') {
      event.preventDefault();
      ctx.onToggleCodeBlockLineWrap?.();
      return;
    }

    // Mermaid copy source / ascii
    if (action === 'mermaid-copy') {
      const source = actionEl.getAttribute('data-md-source') ?? '';
      if (source) void copyTextToClipboard(source).then(() => flashCopied(actionEl as HTMLButtonElement, ctx.labels.copied, 'copy', ctx.labels.copyDiagram));
      return;
    }

    // Mermaid local pan/zoom controls
    if (action === 'mermaid-zoom-in' || action === 'mermaid-zoom-out' || action === 'mermaid-fit') {
      event.preventDefault();
      const block = actionEl.closest('[data-markdown="mermaid-block"]');
      const controller = getMermaidViewerController(block);
      if (action === 'mermaid-zoom-in') {
        controller?.zoomIn();
      } else if (action === 'mermaid-zoom-out') {
        controller?.zoomOut();
      } else {
        controller?.fit();
      }
      return;
    }

    // Mermaid download svg
    if (action === 'mermaid-download') {
      const svgHost = actionEl.closest('[data-markdown="mermaid-block"]')?.querySelector('[data-markdown="mermaid"]');
      const svg = svgHost?.getAttribute('data-md-original-svg') ?? svgHost?.innerHTML ?? '';
      if (svg) downloadBlob('diagram.svg', svg, 'image/svg+xml;charset=utf-8');
      return;
    }

    // Loopback preview
    if (action === 'preview-loopback') {
      event.preventDefault();
      const url = actionEl.getAttribute('data-md-url') ?? '';
      if (url) ctx.onPreviewLoopback?.(url);
      return;
    }
  };

  container.addEventListener('click', handleClick);
  return () => container.removeEventListener('click', handleClick);
};