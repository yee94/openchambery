import React from 'react';
import morphdom from 'morphdom';
import { renderMermaidASCII, renderMermaidSVG } from 'beautiful-mermaid';
import type { Part } from '@opencode-ai/sdk/v2';
import { useEvent, useEventListener, useResizeObserver } from '@reactuses/core';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isExternalHttpUrl, openExternalUrl } from '@/lib/url';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
import type { ToolPopupContent } from './message/types';
import { FadeInOnReveal } from './message/FadeInOnReveal';
import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { EditorAPI } from '@/lib/api/types';
import { isDesktopBinaryPath, isDesktopLocalOriginActive, isDesktopShell, isVSCodeRuntime, openDesktopPath } from '@/lib/desktop';
import { ensureOutsideFileGrantForDesktop } from '@/lib/outsideFileGrants';
import { getDirectoryForFilePath, isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import { isImageFile } from '@/lib/toolHelpers';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { getClientPlatform } from '@/lib/platform';
import { renderMarkdownBlocks, renderMarkdownSyncBlocks } from './markdown/markdownCore';
import { ensureMarkdownShikiTheme, getMarkdownSyntaxVars } from './markdown/markdownTheme';
import { MarkdownLoadingPlaceholder } from './markdown/MarkdownLoadingSkeleton';
import { markdownHeightCacheKey, rememberMarkdownHeight } from './markdown/markdownHeightCache';
import {
  attachMarkdownInteractions,
  applyMarkdownCodeBlockWrapState,
  clearMarkdownImagePlaceholder,
  decorateMarkdown,
  setMarkdownImagePlaceholder,
  syncMarkdownCodeLineNumbers,
  type DecorateContext,
  type DecorateLabels,
  type MermaidControlOptions,
  type MermaidRender,
} from './markdown/decorate';
import { createMermaidViewerRegistry, MERMAID_BLOCK_SELECTOR, shouldRefreshMermaidViewers } from './markdown/mermaidViewer';
import { scheduleAfterPaintTask } from '@/lib/afterPaintTaskQueue';
import { DualLimitLru } from '@/lib/dualLimitLru';
import { resolveStreamingRenderCadence } from './streamingRenderCadence';
import { createMobileLongPressController } from '@/components/ui/mobileLongPress';
import { openImageSaveActions } from './imageSaveActionsBus';
import { fetchRuntimeImageObjectUrl, needsRuntimeImageStream, releaseRuntimeImageObjectUrl, resolveImageSource } from './imageSource';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import {
  BLOCK_PATH_TOKEN_RE,
  PARAGRAPH_PATH_TOKEN_RE,
  isAbsoluteReferencePath,
  isLikelyFileReferencePath,
  normalizeReferencePath,
  parseFileReference,
  type ParsedFileReference,
} from './fileReferenceParser';

const useCurrentMermaidTheme = () => {
  const themeSystem = useOptionalThemeSystem();
  const fallbackLight = getDefaultTheme(false);
  const fallbackDark = getDefaultTheme(true);

  return themeSystem?.currentTheme
    ?? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? fallbackDark
      : fallbackLight);
};

const useExternalLinkInteractions = ({
  containerRef,
  enabled,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  enabled?: boolean;
}) => {
  const handleClick = useEvent((event: MouseEvent) => {
    if (enabled === false) {
      return;
    }

    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (target.closest(MARKDOWN_IMAGE_SELECTOR)) {
      return;
    }

    const anchor = target.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) {
      return;
    }

    if (anchor.getAttribute('data-openchamber-file-link') === 'true') {
      return;
    }

    const href = anchor.getAttribute('href') ?? '';
    if (!isExternalHttpUrl(href)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(href);
  });

  // Always attach to the container; the handler no-ops when disabled. Passing
  // null would fall through useEventListener to window, which is wrong.
  useEventListener('click', handleClick, containerRef);
};

const MARKDOWN_IMAGE_SELECTOR = 'img:not([data-md-link-favicon="true"])';

const getMarkdownImageSource = (image: HTMLImageElement): string => (
  image.getAttribute('data-md-image-source') ?? image.getAttribute('src') ?? ''
);

type RelayImageState = {
  key: string;
  controller?: AbortController;
  objectUrl?: string;
};

const useMarkdownImageInteractions = ({
  containerRef,
  effectiveDirectory,
  onShowPopup,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  effectiveDirectory: string;
  onShowPopup?: (content: ToolPopupContent) => void;
}) => {
  const transportIdentityRef = React.useRef<string | null>(null);
  transportIdentityRef.current ??= getRuntimeTransportIdentity();
  const transportIdentity = transportIdentityRef.current;
  const imagePreviewEnabled = Boolean(onShowPopup);
  const showPopup = useEvent((content: ToolPopupContent) => onShowPopup?.(content));
  const reconcileRef = React.useRef<(root: HTMLElement) => void>(() => {});
  const imagesRef = React.useRef(new Map<HTMLImageElement, RelayImageState>());
  const deferredImageCleanupTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconcileMarkdownImageResources = React.useMemo(
    () => (root: HTMLElement) => reconcileRef.current(root),
    [],
  );

  // useLayoutEffect so reconcile is armed before Morphdom's first-paint layout
  // commit decorates placeholders and immediately auto-loads them.
  React.useLayoutEffect(() => {
    const images = imagesRef.current;
    if (deferredImageCleanupTimerRef.current !== null) {
      clearTimeout(deferredImageCleanupTimerRef.current);
      deferredImageCleanupTimerRef.current = null;
    }

    reconcileRef.current = () => {};
    if (!imagePreviewEnabled) {
      for (const [image, state] of images) {
        state.controller?.abort();
        if (state.objectUrl) {
          releaseRuntimeImageObjectUrl(state.objectUrl);
        }
        images.delete(image);
      }
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const openImage = (image: HTMLImageElement) => {
      const images = Array.from(container.querySelectorAll<HTMLImageElement>(MARKDOWN_IMAGE_SELECTOR));
      const index = images.indexOf(image);
      if (index < 0) return;
      const gallery = images.map((item) => ({
        url: getMarkdownImageSource(item),
        filename: item.alt || getMarkdownImageSource(item) || undefined,
      })).filter((item) => item.url);
      const selectedSource = getMarkdownImageSource(image);
      const galleryIndex = gallery.findIndex((item) => item.url === selectedSource);
      const filename = image.alt || selectedSource;
      showPopup({
        open: true,
        title: filename,
        content: '',
        metadata: { tool: 'image-preview', filename },
        image: { url: selectedSource, filename, gallery, index: Math.max(0, galleryIndex) },
      });
    };

    // Runtime-file images (file://, absolute paths) must stream through the
    // runtime API on every transport — packaged Electron and local web both
    // block raw file:// img.src. Direct http(s)/data/blob images stay as-is.
    const clearImage = (image: HTMLImageElement) => {
      const state = images.get(image);
      if (!state) return;
      state.controller?.abort();
      if (state.objectUrl) {
        releaseRuntimeImageObjectUrl(state.objectUrl);
      }
      images.delete(image);
    };

    const getImageKey = (image: HTMLImageElement): string | undefined => {
      const source = getMarkdownImageSource(image);
      const resolved = resolveImageSource(source, effectiveDirectory);
      if (!needsRuntimeImageStream(resolved)) {
        return undefined;
      }
      return `${transportIdentity}\n${effectiveDirectory}\n${source}`;
    };

    const ensureImageState = (image: HTMLImageElement): RelayImageState | undefined => {
      const key = getImageKey(image);
      if (!key) {
        clearImage(image);
        return undefined;
      }

      const existing = images.get(image);
      if (existing?.key === key) {
        return existing;
      }

      clearImage(image);
      const state = { key };
      images.set(image, state);
      return state;
    };

    const loadImage = (image: HTMLImageElement, state: RelayImageState) => {
      if (state.controller || state.objectUrl || !container.contains(image)) {
        return;
      }

      const source = getMarkdownImageSource(image);
      const resolved = resolveImageSource(source, effectiveDirectory);
      if (!needsRuntimeImageStream(resolved)) {
        clearImage(image);
        return;
      }

      const controller = new AbortController();
      state.controller = controller;
      image.setAttribute('data-md-image-state', 'loading');
      image.setAttribute('aria-busy', 'true');
      void fetchRuntimeImageObjectUrl(resolved.path, controller.signal)
        .then((objectUrl) => {
          const latest = images.get(image);
          if (
            !latest
            || latest !== state
            || latest.controller !== controller
            || controller.signal.aborted
          ) {
            releaseRuntimeImageObjectUrl(objectUrl);
            return;
          }
          latest.controller = undefined;
          latest.objectUrl = objectUrl;
          clearMarkdownImagePlaceholder(image);
          image.setAttribute('data-md-image-state', 'loaded');
          image.src = objectUrl;
        })
        .catch(() => {
          const latest = images.get(image);
          if (latest === state) {
            latest.controller = undefined;
            image.removeAttribute('aria-busy');
            image.setAttribute('data-md-image-state', 'placeholder');
          }
        });
    };

    reconcileRef.current = (root) => {
      for (const [image, state] of images) {
        if (!root.contains(image) || getImageKey(image) !== state.key) {
          clearImage(image);
        }
      }
      for (const image of Array.from(root.querySelectorAll<HTMLImageElement>(MARKDOWN_IMAGE_SELECTOR))) {
        const state = ensureImageState(image);
        if (state && !state.objectUrl) {
          loadImage(image, state);
        }
      }
    };
    // React StrictMode re-runs layout effects after their cleanup while keeping
    // this DOM subtree mounted. Reconcile now so the next setup adopts the
    // existing stream instead of opening a second virtual-asset URL.
    reconcileRef.current(container);

    const activateImage = (image: HTMLImageElement) => {
      const state = ensureImageState(image);
      if (state && !state.objectUrl) {
        loadImage(image, state);
        return;
      }
      openImage(image);
    };

    const openSaveForImage = (image: HTMLImageElement) => {
      const source = getMarkdownImageSource(image);
      if (!source) return;
      openImageSaveActions({
        sourceUrl: source,
        displayUrl: image.currentSrc || image.src || undefined,
        filename: image.alt || source,
        effectiveDirectory,
      });
    };

    const longPress = createMobileLongPressController();
    const imagePressKey = (image: HTMLImageElement): string => (
      getMarkdownImageSource(image) || image.src || 'markdown-image'
    );

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const image = target.closest<HTMLImageElement>(MARKDOWN_IMAGE_SELECTOR);
      if (!image) return;
      if (longPress.consumeClick(imagePressKey(image))) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      activateImage(image);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target;
      if (!(target instanceof HTMLImageElement) || !target.matches(MARKDOWN_IMAGE_SELECTOR)) return;
      event.preventDefault();
      event.stopPropagation();
      activateImage(target);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const image = target.closest<HTMLImageElement>(MARKDOWN_IMAGE_SELECTOR);
      if (!image) return;
      longPress.start({
        pointerId: event.pointerId,
        key: imagePressKey(image),
        clientX: event.clientX,
        clientY: event.clientY,
        onTrigger: () => openSaveForImage(image),
      });
    };
    const handlePointerMove = (event: PointerEvent) => {
      longPress.move(event.pointerId, event.clientX, event.clientY);
    };
    const handlePointerUp = (event: PointerEvent) => {
      longPress.end(event.pointerId);
    };
    const handlePointerCancel = (event: PointerEvent) => {
      longPress.cancel(event.pointerId);
    };
    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const image = target.closest<HTMLImageElement>(MARKDOWN_IMAGE_SELECTOR);
      if (!image) return;
      event.preventDefault();
      event.stopPropagation();
      longPress.openFromContextMenu(imagePressKey(image), () => openSaveForImage(image));
    };

    container.addEventListener('click', handleClick);
    container.addEventListener('keydown', handleKeyDown);
    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('pointermove', handlePointerMove);
    container.addEventListener('pointerup', handlePointerUp);
    container.addEventListener('pointercancel', handlePointerCancel);
    container.addEventListener('contextmenu', handleContextMenu);

    return () => {
      reconcileRef.current = () => {};
      longPress.reset();
      container.removeEventListener('click', handleClick);
      container.removeEventListener('keydown', handleKeyDown);
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('pointermove', handlePointerMove);
      container.removeEventListener('pointerup', handlePointerUp);
      container.removeEventListener('pointercancel', handlePointerCancel);
      container.removeEventListener('contextmenu', handleContextMenu);
      // A StrictMode effect replay tears down and restores this effect in the
      // same task. Keep the virtual URL through that replay so Chromium never
      // races a just-cancelled openchamber-asset request. A real unmount reaches
      // this timer without a following setup and releases every resource.
      deferredImageCleanupTimerRef.current = setTimeout(() => {
        deferredImageCleanupTimerRef.current = null;
        for (const image of Array.from(images.keys())) {
          if (container.contains(image)) {
            setMarkdownImagePlaceholder(image);
          }
          clearImage(image);
        }
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lifecycle inputs are explicit; useEvent supplies the latest popup callback.
  }, [containerRef, effectiveDirectory, imagePreviewEnabled, transportIdentity]);

  return { reconcileMarkdownImageResources, transportIdentity };
};

const DEFAULT_MERMAID_CONTROLS: MermaidControlOptions = {
  download: true,
  copy: true,
  showPanZoomControls: true,
};
const DEFAULT_MERMAID_FULLSCREEN_ENABLED = true;

const stripLeadingFrontmatter = (markdown: string): string => {
  const frontmatterMatch = markdown.match(
    /^(?:\uFEFF)?(---|\+\+\+)[^\S\r\n]*\r?\n[\s\S]*?\r?\n\1[^\S\r\n]*(?:\r?\n|$)/,
  );

  if (!frontmatterMatch) {
    return markdown;
  }

  return markdown.slice(frontmatterMatch[0].length);
};

export type MarkdownVariant = 'assistant' | 'tool' | 'reasoning';

interface MarkdownRendererProps {
  content: string;
  part?: Part;
  messageId: string;
  isAnimated?: boolean;
  skipFadeIn?: boolean;
  className?: string;
  isStreaming?: boolean;
  disableStreamAnimation?: boolean;
  variant?: MarkdownVariant;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFileReferences?: boolean;
}

const FILE_LINK_SELECTOR = '[data-openchamber-file-link="true"]';
const BLOCK_PATH_TOKEN_ATTR = 'data-openchamber-block-path-token';
const BLOCK_PATH_TOKEN_SELECTOR = `[${BLOCK_PATH_TOKEN_ATTR}]`;
const CODE_BLOCK_PATH_SCANNED_ATTR = 'data-openchamber-block-paths-scanned';
const PARAGRAPH_BLOCK_PATH_SCANNED_ATTR = 'data-openchamber-paragraph-paths-scanned';
// Matches `path[:line[:col]]` or `path:start-end` inside shell/grep-style
// output. The regex is defined in `./fileReferenceParser`; the inline-code
// pipeline reads full text content rather than using this regex.
const MAX_BLOCK_CODE_SCAN_LENGTH = 200_000;
const FILE_REFERENCE_STAT_CONCURRENCY = 4;
const FILE_REFERENCE_STAT_CACHE_MAX = 1000;
const VSCODE_FILE_REFERENCE_STAT_CACHE_MAX = 200;
const FILE_REFERENCE_LINK_LIMIT = 80;
const VSCODE_FILE_REFERENCE_LINK_LIMIT = 40;
const FILE_REFERENCE_ANNOTATION_DELAY_MS = 160;
type FileReferenceInfo = { exists: boolean; isBinary: boolean };

const FILE_REFERENCE_STAT_CACHE = new Map<string, Promise<FileReferenceInfo>>();
let activeFileReferenceStatCount = 0;
const pendingFileReferenceStats: Array<() => void> = [];

const getFileReferenceStatCacheMax = (): number => (
  isVSCodeRuntime() ? VSCODE_FILE_REFERENCE_STAT_CACHE_MAX : FILE_REFERENCE_STAT_CACHE_MAX
);

const getFileReferenceLinkLimit = (): number => (
  isVSCodeRuntime() ? VSCODE_FILE_REFERENCE_LINK_LIMIT : FILE_REFERENCE_LINK_LIMIT
);

const normalizePath = (value: string): string => {
  return normalizeReferencePath(value);
};

const isAbsolutePath = (value: string): boolean => {
  return isAbsoluteReferencePath(value);
};

const toAbsolutePath = (basePath: string, targetPath: string): string => {
  return toAbsoluteFilePath(basePath, targetPath);
};

const isLikelyFilePathValue = (path: string): boolean => {
  return isLikelyFileReferencePath(path);
};

const isLikelyFilePath = (value: string): boolean => {
  const parsed = parseFileReference(value);
  if (!parsed) {
    return false;
  }
  return isLikelyFilePathValue(parsed.path);
};

const findTextPosition = (textNodes: Text[], targetOffset: number): { node: Text; offset: number } | null => {
  let currentOffset = 0;

  for (const node of textNodes) {
    const nextOffset = currentOffset + node.data.length;
    if (targetOffset <= nextOffset) {
      return { node, offset: Math.max(0, targetOffset - currentOffset) };
    }
    currentOffset = nextOffset;
  }

  const lastNode = textNodes.at(-1);
  return lastNode ? { node: lastNode, offset: lastNode.data.length } : null;
};

const unwrapBlockCodePathTokens = (container: HTMLElement): void => {
  const tokenSpans = container.querySelectorAll<HTMLElement>(BLOCK_PATH_TOKEN_SELECTOR);
  for (const span of Array.from(tokenSpans)) {
    span.replaceWith(container.ownerDocument.createTextNode(span.textContent ?? ''));
  }

  const scannedBlocks = container.querySelectorAll<HTMLElement>(`code[${CODE_BLOCK_PATH_SCANNED_ATTR}]`);
  for (const codeBlock of Array.from(scannedBlocks)) {
    codeBlock.removeAttribute(CODE_BLOCK_PATH_SCANNED_ATTR);
    codeBlock.normalize();
  }

  const scannedParagraphs = container.querySelectorAll<HTMLElement>(`[${PARAGRAPH_BLOCK_PATH_SCANNED_ATTR}]`);
  for (const paragraph of Array.from(scannedParagraphs)) {
    paragraph.removeAttribute(PARAGRAPH_BLOCK_PATH_SCANNED_ATTR);
    paragraph.normalize();
  }
};

const extractPathCandidateFromElement = (element: HTMLElement): string => {
  if (element.tagName.toLowerCase() === 'a') {
    const href = element.getAttribute('href')?.trim();
    if (href && isLikelyFilePath(href)) {
      return href;
    }
  }

  return (element.textContent || '').trim();
};

// Walks text nodes inside `<pre><code>` subtrees and wraps any substring that
// looks like a `path[:line[:col]]` reference in a span carrying
// `data-openchamber-block-path-token`. `annotateFileLinks` then promotes those
// spans into clickable file links via the same existing pipeline used for
// inline code (parseFileReference → fileReferenceExists → openFileReference).
//
// Idempotent: each `<code>` node is marked with
// `data-openchamber-block-paths-scanned` once processed so the walk is not
// repeated on the same element. When the renderer replaces the `<code>` subtree
// (e.g. on content change during streaming), the new element lacks the marker and
// will be rescanned on the next mutation-observer callback.
const wrapBlockCodePathTokens = (container: HTMLElement): void => {
  const codeBlocks = container.querySelectorAll<HTMLElement>('pre code');
  if (codeBlocks.length === 0) {
    return;
  }

  const doc = container.ownerDocument;
  if (!doc) {
    return;
  }

  for (const codeBlock of Array.from(codeBlocks)) {
    if (codeBlock.getAttribute(CODE_BLOCK_PATH_SCANNED_ATTR) === 'true') {
      continue;
    }

    // Skip absurdly large code blocks to keep DOM work bounded.
    if ((codeBlock.textContent ?? '').length > MAX_BLOCK_CODE_SCAN_LENGTH) {
      codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    const walker = doc.createTreeWalker(codeBlock, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      textNodes.push(currentNode as Text);
      currentNode = walker.nextNode();
    }

    const fullText = codeBlock.textContent ?? '';
    if (!fullText.includes('.')) {
      codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    BLOCK_PATH_TOKEN_RE.lastIndex = 0;
    const matches: Array<{ start: number; end: number; raw: string }> = [];
    let match: RegExpExecArray | null = BLOCK_PATH_TOKEN_RE.exec(fullText);
    while (match) {
      const raw = match[0];
      if (raw && isLikelyFilePath(raw)) {
        matches.push({ start: match.index, end: match.index + raw.length, raw });
      }
      match = BLOCK_PATH_TOKEN_RE.exec(fullText);
    }

    for (const { start, end, raw } of matches.reverse()) {
      const startPosition = findTextPosition(textNodes, start);
      const endPosition = findTextPosition(textNodes, end);
      if (!startPosition || !endPosition) {
        continue;
      }

      const range = doc.createRange();
      range.setStart(startPosition.node, startPosition.offset);
      range.setEnd(endPosition.node, endPosition.offset);

      const span = doc.createElement('span');
      span.setAttribute(BLOCK_PATH_TOKEN_ATTR, 'true');
      span.textContent = raw;

      range.deleteContents();
      range.insertNode(span);
    }

    codeBlock.setAttribute(CODE_BLOCK_PATH_SCANNED_ATTR, 'true');
  }
};

const PARAGRAPH_SCAN_EXCLUDE_SELECTOR = 'pre, code, a, script, style, button, [data-openchamber-file-link], [data-openchamber-block-path-token]';

// Walks ordinary paragraph / heading / list-item / blockquote / table-cell
// subtrees and wraps any substring that looks like a `path[:line[:col]]`
// reference in a span carrying `data-openchamber-block-path-token`. This
// covers the common case where the assistant emits a bare path as regular
// prose (no backticks, no markdown link), e.g.
// `完整规格已更新至：domains/venture/.../最终方案.md`.
//
// The pass is intentionally conservative:
// - Skips any text node inside an excluded subtree (code, existing links,
//   previously-annotated tokens).
// - Only matches tokens that contain a `/` separator and an extension-bearing
//   final segment (see PARAGRAPH_PATH_TOKEN_RE).
// - Each candidate is then filtered through `isLikelyFilePath` and, later,
//   `fileReferenceExists` — so a false positive never becomes a clickable
//   link, it just produces a bounded stat probe.
//
// Idempotent per element: each block-level container is marked with
// `data-openchamber-paragraph-paths-scanned` once processed. The mutation
// observer clears the marker via `unwrapBlockCodePathTokens` (which also
// unwraps paragraph tokens, since they share the same attribute).
const wrapParagraphPathTokens = (container: HTMLElement): void => {
  const doc = container.ownerDocument;
  if (!doc) {
    return;
  }

  const blockContainers = container.querySelectorAll<HTMLElement>(
    'p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th',
  );
  if (blockContainers.length === 0) {
    return;
  }

  for (const block of Array.from(blockContainers)) {
    if (block.getAttribute(PARAGRAPH_BLOCK_PATH_SCANNED_ATTR) === 'true') {
      continue;
    }
    if (block.closest(PARAGRAPH_SCAN_EXCLUDE_SELECTOR)) {
      block.setAttribute(PARAGRAPH_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest(PARAGRAPH_SCAN_EXCLUDE_SELECTOR)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes: Text[] = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
      textNodes.push(currentNode as Text);
      currentNode = walker.nextNode();
    }

    if (textNodes.length === 0) {
      block.setAttribute(PARAGRAPH_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    const fullText = textNodes.map((node) => node.data).join('');
    if (!fullText.includes('/') || !fullText.includes('.')) {
      block.setAttribute(PARAGRAPH_BLOCK_PATH_SCANNED_ATTR, 'true');
      continue;
    }

    PARAGRAPH_PATH_TOKEN_RE.lastIndex = 0;
    const matches: Array<{ start: number; end: number; raw: string }> = [];
    let match: RegExpExecArray | null = PARAGRAPH_PATH_TOKEN_RE.exec(fullText);
    while (match) {
      const raw = match[0];
      if (!raw) {
        match = PARAGRAPH_PATH_TOKEN_RE.exec(fullText);
        continue;
      }

      // Reject candidates that are actually the tail of a URL scheme
      // (`https://example.com/path/file.md` → `/example.com/path/file.md`).
      // A real URL has `scheme://` before the candidate, so the two
      // characters before the match are `:/` (when the candidate itself
      // starts with `/`) or the single character before is `:` (when the
      // candidate does not start with `/`).
      const prevTwo = match.index >= 2 ? fullText.slice(match.index - 2, match.index) : '';
      const prevChar = match.index >= 1 ? fullText.charAt(match.index - 1) : '';
      if (prevChar === ':' || prevTwo === ':/') {
        match = PARAGRAPH_PATH_TOKEN_RE.exec(fullText);
        continue;
      }

      if (isLikelyFilePath(raw)) {
        matches.push({ start: match.index, end: match.index + raw.length, raw });
      }
      match = PARAGRAPH_PATH_TOKEN_RE.exec(fullText);
    }

    for (const { start, end, raw } of matches.reverse()) {
      const startPosition = findTextPosition(textNodes, start);
      const endPosition = findTextPosition(textNodes, end);
      if (!startPosition || !endPosition) {
        continue;
      }

      const range = doc.createRange();
      range.setStart(startPosition.node, startPosition.offset);
      range.setEnd(endPosition.node, endPosition.offset);

      const span = doc.createElement('span');
      span.setAttribute(BLOCK_PATH_TOKEN_ATTR, 'true');
      span.textContent = raw;

      range.deleteContents();
      range.insertNode(span);
    }

    block.setAttribute(PARAGRAPH_BLOCK_PATH_SCANNED_ATTR, 'true');
  }
};

const getResolvedReference = (rawValue: string, effectiveDirectory: string): (ParsedFileReference & { resolvedPath: string }) | null => {
  const parsed = parseFileReference(rawValue);
  if (!parsed || !isLikelyFilePathValue(parsed.path)) {
    return null;
  }

  const resolvedPath = isAbsolutePath(parsed.path)
    ? normalizePath(parsed.path)
    : toAbsolutePath(effectiveDirectory, parsed.path);
  if (!resolvedPath) {
    return null;
  }

  return {
    ...parsed,
    resolvedPath,
  };
};

const getFileReferenceInfo = (resolvedPath: string): Promise<FileReferenceInfo> => {
  const normalizedPath = normalizePath(resolvedPath);
  if (!normalizedPath) {
    return Promise.resolve({ exists: false, isBinary: false });
  }

  const cached = FILE_REFERENCE_STAT_CACHE.get(normalizedPath);
  if (cached) {
    FILE_REFERENCE_STAT_CACHE.delete(normalizedPath);
    FILE_REFERENCE_STAT_CACHE.set(normalizedPath, cached);
    return cached;
  }

  const request = new Promise<FileReferenceInfo>((resolve) => {
    const run = () => {
      activeFileReferenceStatCount += 1;
      void runtimeFetch(`/api/fs/stat?path=${encodeURIComponent(normalizedPath)}&optional=true`, {
        method: 'GET',
        cache: 'no-store',
      })
        .then(async (response) => {
          if (!response.ok) {
            resolve({ exists: false, isBinary: false });
            return;
          }
          const payload = await response.json().catch(() => null) as { exists?: unknown; isBinary?: unknown } | null;
          resolve({ exists: payload?.exists !== false, isBinary: payload?.isBinary === true });
        })
        .catch(() => resolve({ exists: false, isBinary: false }))
        .finally(() => {
          activeFileReferenceStatCount = Math.max(0, activeFileReferenceStatCount - 1);
          pendingFileReferenceStats.shift()?.();
        });
    };

    if (activeFileReferenceStatCount < FILE_REFERENCE_STAT_CONCURRENCY) {
      run();
      return;
    }

    pendingFileReferenceStats.push(run);
  });

  const maxCacheEntries = getFileReferenceStatCacheMax();
  while (FILE_REFERENCE_STAT_CACHE.size >= maxCacheEntries) {
    const oldest = FILE_REFERENCE_STAT_CACHE.keys().next().value;
    if (typeof oldest !== 'string') {
      break;
    }
    FILE_REFERENCE_STAT_CACHE.delete(oldest);
  }
  FILE_REFERENCE_STAT_CACHE.set(normalizedPath, request);
  return request;
};

const getContextDirectory = (effectiveDirectory: string, resolvedPath: string): string => {
  return effectiveDirectory || getDirectoryForFilePath(effectiveDirectory, resolvedPath);
};

const useFileReferenceInteractions = ({
  containerRef,
  effectiveDirectory,
  editor,
  preferRuntimeEditor,
  enabled,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  effectiveDirectory: string;
  editor?: EditorAPI;
  preferRuntimeEditor?: boolean;
  enabled: boolean;
}) => {
  const annotationDebounceRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;
    const isMobileSurface = isMobileSurfaceRuntime();
    const fileReferenceLinkLimit = getFileReferenceLinkLimit();
    // File-reference highlighting runs on every surface. The annotation pass
    // issues filesystem `stat` probes (getFileReferenceInfo → /api/fs/stat);
    // concurrency (FILE_REFERENCE_STAT_CONCURRENCY) and the bounded
    // FILE_REFERENCE_STAT_CACHE keep the request volume in check on
    // constrained runtimes. Mobile only annotates files it can preview.
    const fileReferencesEnabled = enabled;

    const clearFileLinkAttributes = (candidate: HTMLElement) => {
      candidate.removeAttribute('data-openchamber-file-link');
      candidate.removeAttribute('data-openchamber-file-ref');
      candidate.removeAttribute('data-openchamber-file-path');
      candidate.removeAttribute('data-openchamber-file-binary');
      if (candidate.getAttribute('title') === 'Open file') {
        candidate.removeAttribute('title');
      }
      if (candidate.tagName.toLowerCase() !== 'a') {
        candidate.removeAttribute('role');
        candidate.removeAttribute('tabindex');
      }
    };

    const clearAnnotatedFileLinks = () => {
      const annotated = container.querySelectorAll<HTMLElement>(FILE_LINK_SELECTOR);
      for (const candidate of Array.from(annotated)) {
        clearFileLinkAttributes(candidate);
      }
      unwrapBlockCodePathTokens(container);
    };

    if (!fileReferencesEnabled) {
      clearAnnotatedFileLinks();
      return;
    }

    const scheduleAnnotation = (delayMs = 0) => {
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      if (typeof window === 'undefined') {
        annotateFileLinks();
        return;
      }
      annotationDebounceRef.current = window.setTimeout(() => {
        annotationDebounceRef.current = null;
        window.requestAnimationFrame(() => {
          if (!cancelled) {
            annotateFileLinks();
          }
        });
      }, delayMs);
    };

    const annotateFileLinks = () => {
      if (fileReferencesEnabled) {
        wrapBlockCodePathTokens(container);
        wrapParagraphPathTokens(container);
      }
      const candidates = container.querySelectorAll<HTMLElement>(
        `[data-markdown="inline-code"], a, ${BLOCK_PATH_TOKEN_SELECTOR}`,
      );
      let linkedCount = 0;

      for (const candidate of Array.from(candidates)) {
        const rawCandidate = extractPathCandidateFromElement(candidate);
        const resolved = getResolvedReference(rawCandidate, effectiveDirectory);
        clearFileLinkAttributes(candidate);

        if (!resolved) {
          continue;
        }

        if (linkedCount >= fileReferenceLinkLimit) {
          continue;
        }

        linkedCount += 1;

        const canGrantOutsideFile = isDesktopShell()
          && isDesktopLocalOriginActive()
          && !isFilePathWithinDirectory(resolved.resolvedPath, effectiveDirectory);
        const infoPromise = canGrantOutsideFile
          ? isDesktopBinaryPath(resolved.resolvedPath).then((isBinary) => ({ exists: true, isBinary: isBinary === true }))
          : getFileReferenceInfo(resolved.resolvedPath);

        void infoPromise.then((info) => {
          if (cancelled || !info.exists || !container.contains(candidate)) {
            return;
          }

          const latestRawCandidate = extractPathCandidateFromElement(candidate);
          const latestResolved = getResolvedReference(latestRawCandidate, effectiveDirectory);
          if (!latestResolved || latestResolved.resolvedPath !== resolved.resolvedPath) {
            return;
          }
          if (isMobileSurface && info.isBinary && !isImageFile(latestResolved.resolvedPath)) {
            return;
          }

          candidate.setAttribute('data-openchamber-file-link', 'true');
          candidate.setAttribute('data-openchamber-file-ref', latestRawCandidate);
          candidate.setAttribute('data-openchamber-file-path', latestResolved.resolvedPath);
          candidate.setAttribute('data-openchamber-file-binary', String(info.isBinary));
          candidate.setAttribute('title', 'Open file');
          if (candidate.tagName.toLowerCase() !== 'a') {
            candidate.setAttribute('role', 'button');
            candidate.setAttribute('tabindex', '0');
          }
        });
      }
    };

    const openFileReference = async (sourceElement: HTMLElement) => {
      const raw = sourceElement.getAttribute('data-openchamber-file-ref') || extractPathCandidateFromElement(sourceElement);
      const resolved = getResolvedReference(raw, effectiveDirectory);
      if (!resolved) {
        return;
      }

      const isBinary = sourceElement.getAttribute('data-openchamber-file-binary') === 'true';
      const isApplicationBundle = resolved.resolvedPath.toLowerCase().endsWith('.app');
      if ((isBinary || isApplicationBundle) && !isImageFile(resolved.resolvedPath)) {
        if (await openDesktopPath(resolved.resolvedPath)) {
          return;
        }
      }

      const contextDirectory = getContextDirectory(effectiveDirectory, resolved.resolvedPath);
      if (preferRuntimeEditor && editor) {
        void editor.openFile(
          resolved.resolvedPath,
          Number.isFinite(resolved.line ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.line as number))
            : undefined,
          Number.isFinite(resolved.column ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.column as number))
            : undefined,
        );
        return;
      }

      if (!isFilePathWithinDirectory(resolved.resolvedPath, effectiveDirectory)) {
        await ensureOutsideFileGrantForDesktop(resolved.resolvedPath, effectiveDirectory);
      }

      const uiStore = useUIStore.getState();
      if (Number.isFinite(resolved.line ?? Number.NaN)) {
        uiStore.openContextFileAtLine(
          contextDirectory,
          resolved.resolvedPath,
          Math.max(1, Math.trunc(resolved.line as number)),
          Number.isFinite(resolved.column ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.column as number))
            : 1,
        );
      } else {
        uiStore.openContextFile(contextDirectory, resolved.resolvedPath);
      }
    };

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest(MARKDOWN_IMAGE_SELECTOR)) {
        return;
      }

      const fileRefElement = target.closest(FILE_LINK_SELECTOR);
      if (!(fileRefElement instanceof HTMLElement)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      void openFileReference(fileRefElement);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      const target = event.target;
      if (!(target instanceof HTMLElement) || target.getAttribute('data-openchamber-file-link') !== 'true') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      void openFileReference(target);
    };

    scheduleAnnotation(FILE_REFERENCE_ANNOTATION_DELAY_MS);

    const observer = new MutationObserver(() => {
      scheduleAnnotation(FILE_REFERENCE_ANNOTATION_DELAY_MS);
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
    });

    container.addEventListener('click', handleClick);
    container.addEventListener('keydown', handleKeyDown);

    return () => {
      cancelled = true;
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      annotationDebounceRef.current = null;
      observer.disconnect();
      container.removeEventListener('click', handleClick);
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerRef, editor, effectiveDirectory, preferRuntimeEditor, enabled]);
};

const useMermaidInlineInteractions = ({
  containerRef,
  onShowPopup,
  enableFullscreen,
  enablePanZoom,
  allowMermaidWheelEvents,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFullscreen?: boolean;
  enablePanZoom?: boolean;
  allowMermaidWheelEvents?: boolean;
}) => {
  const showPopup = useEvent((content: ToolPopupContent) => onShowPopup?.(content));
  const popupEnabled = Boolean(onShowPopup);

  const handleMermaidClick = useEvent((event: MouseEvent) => {
    if (!enableFullscreen || !popupEnabled) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (target.closest('button, a, [role="button"]')) {
      return;
    }

    const block = target.closest(MERMAID_BLOCK_SELECTOR);
    if (!block) {
      return;
    }

    if (block instanceof HTMLElement && block.hasAttribute('data-mermaid-suppress-click')) {
      block.removeAttribute('data-mermaid-suppress-click');
      return;
    }

    const renderedBlocks = Array.from(container.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR));
    const blockIndex = renderedBlocks.indexOf(block as HTMLElement);
    if (blockIndex < 0) {
      return;
    }

    const source = block instanceof HTMLElement ? block.getAttribute('data-md-source') : null;
    if (!source || source.trim().length === 0) {
      return;
    }

    const filename = `Diagram ${blockIndex + 1}`;
    showPopup({
      open: true,
      title: filename,
      content: '',
      metadata: {
        tool: 'mermaid-preview',
        filename,
      },
      mermaid: {
        url: `data:text/plain;charset=utf-8,${encodeURIComponent(source)}`,
        source,
        filename,
      },
    });
  });

  const handleInlineWheel = useEvent((event: WheelEvent) => {
    if (allowMermaidWheelEvents || enablePanZoom) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const block = target.closest(MERMAID_BLOCK_SELECTOR);
    if (!block) {
      return;
    }

    // Keep regular page scroll while preventing Streamdown inline wheel-zoom handlers.
    event.stopPropagation();
  });

  useEventListener('click', handleMermaidClick, containerRef);
  // Capture-phase wheel needs matching removeEventListener options;
  // @reactuses/core useEventListener cleanup omits options, so keep a manual effect.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    container.addEventListener('wheel', handleInlineWheel, { capture: true, passive: true });
    return () => {
      container.removeEventListener('wheel', handleInlineWheel, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleInlineWheel is useEvent-stable; identity must not control this effect.
  }, [containerRef]);
};

// ---------------------------------------------------------------------------
// Rendering core: marked -> math -> shiki -> sanitize -> decorate -> morphdom
// ---------------------------------------------------------------------------

// Streaming reveal cadence varies by native platform. Step sizes are auto-scaled
// so reveal throughput (chars/sec) stays constant across the selected cadence.
const PACE_BASELINE_MS = 24;
const MIN_REVEAL_CHARS_PER_FRAME = 1;
const MAX_CATCHUP_CHARS_PER_FRAME = 12;
const TEXT_SNAP = /[\s.,!?;:)\]]/;

const paceStep = (remaining: number, textPaceMs: number): number => {
  const base = remaining <= 12 ? 2 : remaining <= 48 ? 4 : remaining <= 96 ? 8 : Math.min(24, Math.ceil(remaining / 8));
  return Math.max(1, Math.round(base * (textPaceMs / PACE_BASELINE_MS)));
};

// Convert the original stepped cadence into an equivalent per-second throughput.
const charsPerSecond = (remaining: number, textPaceMs: number): number => (
  paceStep(remaining, textPaceMs) * (1000 / textPaceMs)
);

const nextRevealIndex = (text: string, start: number, revealChars: number): number => {
  const end = Math.min(text.length, start + revealChars);
  for (let i = end; i < Math.min(text.length, end + 8); i += 1) {
    if (TEXT_SNAP.test(text[i] ?? '')) return i + 1;
  }
  return end;
};

// Granular streaming reveal. Cheap because each step only re-runs the
// marked->morphdom pipeline (patching changed DOM nodes), with no React tree
// reconciliation of the markdown body.
const usePacedText = (content: string, streaming: boolean, textPaceMs: number): string => {
  const [shown, setShown] = React.useState<number>(() => (streaming ? 0 : content.length));
  const shownRef = React.useRef(shown);
  const carryRef = React.useRef(0);
  const lastTsRef = React.useRef<number | null>(null);
  shownRef.current = shown;

  React.useEffect(() => {
    if (!streaming || typeof window === 'undefined') {
      carryRef.current = 0;
      lastTsRef.current = null;
      setShown(content.length);
      return;
    }
    if (shownRef.current > content.length) {
      shownRef.current = content.length;
      carryRef.current = 0;
      setShown(content.length);
    }

    let frame: number | null = null;
    const tick = (ts: number) => {
      const current = Math.min(shownRef.current, content.length);
      if (current >= content.length) {
        frame = null;
        lastTsRef.current = null;
        return;
      }

      const lastTs = lastTsRef.current;
      if (lastTs === null) {
        lastTsRef.current = ts;
        frame = window.requestAnimationFrame(tick);
        return;
      }

      const dt = Math.min(ts - lastTs, 100);
      lastTsRef.current = ts;
      carryRef.current += charsPerSecond(content.length - current, textPaceMs) * (dt / 1000);
      const revealChars = Math.min(MAX_CATCHUP_CHARS_PER_FRAME, Math.floor(carryRef.current));

      if (revealChars >= MIN_REVEAL_CHARS_PER_FRAME) {
        carryRef.current -= revealChars;
        const next = nextRevealIndex(content, current, revealChars);
        shownRef.current = next;
        setShown(next);
      }

      frame = window.requestAnimationFrame(tick);
    };

    if (shownRef.current < content.length) {
      frame = window.requestAnimationFrame(tick);
    }

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [content, streaming, textPaceMs]);

  if (!streaming) return content;
  return content.slice(0, Math.min(shown, content.length));
};

// Mermaid layout is expensive; `decorate` would otherwise re-render every
// diagram on every paced-stream step (~40/sec). Memoize by theme+mode+source
// so a stable diagram is laid out once and served from cache thereafter.
const MERMAID_RENDER_CACHE_MAX = 100;
const MERMAID_RENDER_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const MERMAID_RENDER_CACHE = new DualLimitLru<string, MermaidRender>({
  maxEntries: MERMAID_RENDER_CACHE_MAX,
  maxBytes: MERMAID_RENDER_CACHE_MAX_BYTES,
});

const cachedMermaidRender = (key: string, compute: () => MermaidRender): MermaidRender => {
  const existing = MERMAID_RENDER_CACHE.get(key);
  if (existing) {
    return existing;
  }
  const value = compute();
  const payloadBytes = ((value.svg?.length ?? 0) + (value.ascii?.length ?? 0)) * 2;
  MERMAID_RENDER_CACHE.set(key, value, key.length * 2 + payloadBytes);
  return value;
};

const mermaidColorsFromTheme = (theme: Theme) => ({
  bg: theme.colors.surface.elevated,
  fg: theme.colors.surface.foreground,
  line: theme.colors.interactive.border,
  accent: theme.colors.primary.base,
  muted: theme.colors.surface.mutedForeground,
  surface: theme.colors.surface.muted,
  border: theme.colors.interactive.border,
  transparent: true,
  font: 'system-ui, sans-serif',
});

const useDecorateContext = (
  currentTheme: Theme,
  deferCodeLineNumberSync: boolean,
  onPreviewLoopback?: (url: string) => void,
  mermaidControls: MermaidControlOptions = DEFAULT_MERMAID_CONTROLS,
  imageTransportIdentity = getRuntimeTransportIdentity(),
  imageEffectiveDirectory = '',
  imagePreviewEnabled = false,
): DecorateContext => {
  const { t } = useI18n();
  const labels: DecorateLabels = React.useMemo(() => ({
    copy: t('markdownRenderer.code.actions.copyTitle'),
    copied: t('markdownRenderer.code.actions.copiedTitle'),
    enableCodeWrap: t('markdownRenderer.code.actions.enableWrapTitle'),
    disableCodeWrap: t('markdownRenderer.code.actions.disableWrapTitle'),
    copyDiagram: t('markdownRenderer.mermaid.actions.copySourceTitle'),
    downloadDiagram: t('markdownRenderer.mermaid.actions.downloadSvgTitle'),
    zoomInDiagram: t('markdownRenderer.mermaid.actions.zoomInTitle'),
    zoomOutDiagram: t('markdownRenderer.mermaid.actions.zoomOutTitle'),
    resetDiagramView: t('markdownRenderer.mermaid.actions.resetViewTitle'),
    previewLabel: t('terminalView.preview.open'),
    previewTitle: t('terminalView.preview.openTitle'),
  }), [t]);

  const codeBlockLineWrap = useUIStore((state) => state.codeBlockLineWrap);
  const setCodeBlockLineWrap = useUIStore((state) => state.setCodeBlockLineWrap);
  const toggleCodeBlockLineWrap = useEvent(() => {
    setCodeBlockLineWrap(!useUIStore.getState().codeBlockLineWrap);
  });

  return React.useMemo<DecorateContext>(() => {
    const colors = mermaidColorsFromTheme(currentTheme);
    const mode = useUIStore.getState().mermaidRenderingMode;
    const themeId = currentTheme.metadata?.id ?? 'theme';
    const renderMermaid = (source: string): MermaidRender =>
      cachedMermaidRender(`${themeId}:${mode}:${source}`, () => {
        try {
          if (mode === 'ascii') return { ascii: renderMermaidASCII(source) };
          return { svg: renderMermaidSVG(source, colors) };
        } catch {
          return {};
        }
      });
    return {
      labels,
      mermaidControls,
      codeBlockLineWrap,
      deferCodeLineNumberSync,
      onToggleCodeBlockLineWrap: toggleCodeBlockLineWrap,
      renderMermaid,
      onPreviewLoopback,
      imageTransportIdentity,
      imageEffectiveDirectory,
      imagePreviewEnabled,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toggleCodeBlockLineWrap is useEvent-stable; identity must not control this memo.
  }, [currentTheme, labels, mermaidControls, codeBlockLineWrap, deferCodeLineNumberSync, onPreviewLoopback, imageTransportIdentity, imageEffectiveDirectory, imagePreviewEnabled]);
};

// Runs the async render pipeline into the container and keeps a stable
// delegated interaction listener attached.
const useMorphdomMarkdown = ({
  containerRef,
  text,
  streaming,
  cacheKey,
  syntaxVars,
  ctx,
  reconcileMarkdownImageResources,
  onRichContentReady,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  text: string;
  streaming: boolean;
  cacheKey: string;
  syntaxVars: Record<string, string>;
  ctx: DecorateContext;
  reconcileMarkdownImageResources: (root: HTMLElement) => void;
  onRichContentReady?: () => void;
}) => {
  React.useEffect(() => {
    ensureMarkdownShikiTheme();
  }, []);

  const mermaidViewerRef = React.useRef<ReturnType<typeof createMermaidViewerRegistry> | null>(null);
  const notifyRichContentReady = useEvent(() => {
    onRichContentReady?.();
  });
  const refreshMermaidViewers = useEvent(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    if (!mermaidViewerRef.current) {
      if (!shouldRefreshMermaidViewers(container)) {
        return;
      }
      mermaidViewerRef.current = createMermaidViewerRegistry(container);
      return;
    }
    mermaidViewerRef.current.refresh();
  });

  // First paint must never flash a loading skeleton over Markdown that the user
  // already saw while streaming. Sync-render into an empty target for both live
  // and completed mounts; completed mounts also reveal in this layout pass so
  // React can drop the placeholder before the browser paints. Async morphdom
  // still upgrades to the rich DOM afterward — never expose raw source.
  // Decoration runs here too (full pass, same as the async commit): tables only
  // reach their final nowrap geometry and code blocks only gain their card
  // chrome through decorate, so deferring it reshapes the layout a frame later
  // — a visible jump the virtualizer then compensates. All passes are
  // idempotent, so the async re-decoration morphs equal structures.
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    if (text && target.childNodes.length === 0) {
      // One element per async render block, so the async pass upgrades each
      // block in place rather than reshaping one whole-document block.
      for (const html of renderMarkdownSyncBlocks(text)) {
        const block = document.createElement('div');
        block.setAttribute('data-md-block', '');
        // `display:contents` keeps margin-collapsing/spacing identical to a flat
        // HTML body — the wrapper exists only for per-block reconciliation.
        block.style.display = 'contents';
        block.innerHTML = html;
        decorateMarkdown(block, ctx);
        target.appendChild(block);
      }
      reconcileMarkdownImageResources(target);
      if (!streaming) {
        notifyRichContentReady();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notifyRichContentReady is useEvent-stable and must not control this effect.
  }, [containerRef, ctx, reconcileMarkdownImageResources, streaming, text]);

  React.useEffect(() => () => {
    mermaidViewerRef.current?.cleanup();
    mermaidViewerRef.current = null;
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    let active = true;
    const renderAbortController = new AbortController();
    let cancelQueuedRender = () => {};
    let cancelQueuedCommit = () => {};

    const commitPlainTextFailureFallback = () => {
      if (!active || streaming || renderAbortController.signal.aborted) {
        return;
      }
      target.replaceChildren();
      const block = document.createElement('div');
      block.setAttribute('data-md-block', '');
      block.setAttribute('data-md-render-fallback', 'text');
      block.style.display = 'contents';
      const fallback = document.createElement('span');
      fallback.style.whiteSpace = 'pre-wrap';
      fallback.textContent = text;
      block.appendChild(fallback);
      target.appendChild(block);
      reconcileMarkdownImageResources(target);
      notifyRichContentReady();
    };

    const commitBlocks = (blocks: Awaited<ReturnType<typeof renderMarkdownBlocks>>) => {
      if (!active) {
        return;
      }
      const existing = Array.from(target.children) as HTMLElement[];

      // Reconcile per block: only re-morph blocks whose content changed, leaving
      // stable leading blocks untouched. Keeps per-stream-step DOM work bounded
      // to the trailing (growing) block instead of the whole message.
      blocks.forEach((block, index) => {
        let el = existing[index];
        if (!el) {
          el = document.createElement('div');
          el.setAttribute('data-md-block', '');
          el.style.display = 'contents';
          target.appendChild(el);
        }
        if (el.getAttribute('data-md-id') === block.id) return;

        const temp = document.createElement('div');
        temp.innerHTML = block.html;
        decorateMarkdown(temp, ctx);
        const hadMermaidBlock = shouldRefreshMermaidViewers(el);
        const tempHasMermaidBlock = shouldRefreshMermaidViewers(temp);
        morphdom(el, temp, {
          childrenOnly: true,
          onBeforeElUpdated: (fromEl, toEl) => {
            if (fromEl instanceof HTMLImageElement && toEl instanceof HTMLImageElement) {
              const source = fromEl.getAttribute('data-md-image-source');
              if (source && source === toEl.getAttribute('data-md-image-source')) {
                const src = fromEl.getAttribute('src');
                if (src === null) toEl.removeAttribute('src');
                else toEl.setAttribute('src', src);
                toEl.className = fromEl.className;
                for (const attribute of ['data-md-image-state', 'data-md-placeholder-source', 'aria-busy']) {
                  const value = fromEl.getAttribute(attribute);
                  if (value === null) toEl.removeAttribute(attribute);
                  else toEl.setAttribute(attribute, value);
                }
              }
            }
            return !fromEl.isEqualNode(toEl);
          },
        });
        el.setAttribute('data-md-id', block.id);
        if (hadMermaidBlock || tempHasMermaidBlock || shouldRefreshMermaidViewers(el)) {
          refreshMermaidViewers();
        }
      });

      // Remove any trailing block elements no longer present.
      const hadMermaidBeforeTrailingCleanup = shouldRefreshMermaidViewers(target);
      let removedMermaidBlock = false;
      for (let i = existing.length - 1; i >= blocks.length; i -= 1) {
        const removed = existing[i];
        if (removed && shouldRefreshMermaidViewers(removed)) {
          removedMermaidBlock = true;
        }
        removed?.remove();
      }
      if (removedMermaidBlock || (existing.length > blocks.length && hadMermaidBeforeTrailingCleanup)) {
        refreshMermaidViewers();
      }
      reconcileMarkdownImageResources(target);

      // Decorate leaves the line-number gutter out, so settled content adds it
      // here (idempotent — blocks that already have one are left alone).
      if (!ctx.deferCodeLineNumberSync) {
        applyMarkdownCodeBlockWrapState(target, ctx.codeBlockLineWrap, ctx.labels);
      }
      notifyRichContentReady();
    };

    const commitBlocksSafely = (blocks: Awaited<ReturnType<typeof renderMarkdownBlocks>>) => {
      try {
        commitBlocks(blocks);
      } catch {
        commitPlainTextFailureFallback();
      }
    };

    const renderBlocks = () => {
      void renderMarkdownBlocks(text, streaming, cacheKey, renderAbortController.signal).then((blocks) => {
        if (!active) {
          return;
        }
        if (streaming) {
          commitBlocksSafely(blocks);
          return;
        }
        cancelQueuedCommit = scheduleAfterPaintTask(
          () => commitBlocksSafely(blocks),
          { priority: 'visible' },
        );
      }).catch(commitPlainTextFailureFallback);
    };

    if (streaming) {
      renderBlocks();
    } else {
      cancelQueuedRender = scheduleAfterPaintTask(renderBlocks, { priority: 'visible' });
    }

    return () => {
      active = false;
      renderAbortController.abort();
      cancelQueuedRender();
      cancelQueuedCommit();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshMermaidViewers / notifyRichContentReady are useEvent-stable and must not control this effect.
  }, [containerRef, text, streaming, cacheKey, ctx, reconcileMarkdownImageResources]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return attachMarkdownInteractions(container, ctx);
  }, [containerRef, ctx]);

  // Apply syntax CSS variables imperatively so they survive morphdom updates.
  React.useEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    for (const [key, value] of Object.entries(syntaxVars)) {
      target.style.setProperty(key, value);
    }
  }, [containerRef, syntaxVars]);

  React.useEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    if (ctx.deferCodeLineNumberSync) return;
    applyMarkdownCodeBlockWrapState(target, ctx.codeBlockLineWrap, ctx.labels);
  }, [containerRef, ctx.codeBlockLineWrap, ctx.deferCodeLineNumberSync, ctx.labels]);

  const codeLineNumberFrameRef = React.useRef<number | null>(null);
  const handleCodeLineNumberResize = useEvent(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    if (codeLineNumberFrameRef.current !== null) {
      window.cancelAnimationFrame(codeLineNumberFrameRef.current);
    }
    codeLineNumberFrameRef.current = window.requestAnimationFrame(() => {
      codeLineNumberFrameRef.current = null;
      syncMarkdownCodeLineNumbers(target);
    });
  });
  useResizeObserver(containerRef, handleCodeLineNumberResize);
  React.useEffect(() => () => {
    if (codeLineNumberFrameRef.current !== null) {
      window.cancelAnimationFrame(codeLineNumberFrameRef.current);
    }
  }, []);
};

const markdownContentClassName = (variant: MarkdownVariant): string =>
  variant === 'tool'
    ? 'markdown-content markdown-tool'
    : variant === 'reasoning'
      ? 'markdown-content markdown-reasoning'
      : 'markdown-content leading-relaxed';

// The rendered Markdown — not the placeholder — is what holds the container
// open, so revealing it never changes the box height and needs no measurement.
// Measuring here used to force a synchronous layout per renderer, and a batch of
// rows revealing together turned that into read/write layout thrashing.
const useRichMarkdownReveal = (initiallyReady: boolean): [boolean, () => void] => {
  const [richReady, setRichReady] = React.useState(initiallyReady);
  const revealedRef = React.useRef(initiallyReady);

  const reveal = useEvent(() => {
    if (revealedRef.current) return;
    revealedRef.current = true;
    setRichReady(true);
  });

  return [richReady, reveal];
};

/**
 * Records what this content actually renders to, so the deferred placeholder in
 * `MarkdownRenderer` can reserve the right box next time the row is recycled
 * out of and back into the virtualized window. Observed box sizes come from the
 * ResizeObserver entry, so nothing here forces a synchronous layout.
 */
const useMarkdownHeightMemo = (
  containerRef: React.RefObject<HTMLDivElement | null>,
  cacheKey: string,
  enabled: boolean,
): void => {
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  const cacheKeyRef = React.useRef(cacheKey);
  cacheKeyRef.current = cacheKey;

  const handleResize = useEvent<ResizeObserverCallback>((entries) => {
    if (!enabledRef.current) return;
    const entry = entries[0];
    if (!entry) return;
    const box = entry.borderBoxSize?.[0];
    const height = box ? box.blockSize : entry.contentRect.height;
    const width = box ? box.inlineSize : entry.contentRect.width;
    rememberMarkdownHeight(cacheKeyRef.current, height, width);
  });

  useResizeObserver(containerRef, handleResize);
};

const MarkdownRendererImpl: React.FC<MarkdownRendererProps> = ({
  content,
  part,
  messageId,
  isAnimated = true,
  skipFadeIn = false,
  className,
  isStreaming = false,
  disableStreamAnimation = false,
  variant = 'assistant',
  onShowPopup,
  enableFileReferences = true,
}) => {
  const currentTheme = useCurrentMermaidTheme();
  const { editor, runtime } = useRuntimeAPIs();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const openContextPreview = useUIStore((state) => state.openContextPreview);

  const handlePreviewLoopback = useEvent((url: string) => {
    if (!effectiveDirectory) return;
    openContextPreview(effectiveDirectory, url);
  });

  const live = isStreaming && !disableStreamAnimation;
  const streamingRenderCadence = resolveStreamingRenderCadence(getClientPlatform());
  const pacedText = usePacedText(content, live, streamingRenderCadence.markdownPaceMs);
  const [richReady, revealRichContent] = useRichMarkdownReveal(live);

  useMermaidInlineInteractions({
    containerRef,
    onShowPopup,
    enableFullscreen: DEFAULT_MERMAID_FULLSCREEN_ENABLED,
    enablePanZoom: DEFAULT_MERMAID_CONTROLS.showPanZoomControls,
  });
  useFileReferenceInteractions({
    containerRef,
    effectiveDirectory,
    editor,
    preferRuntimeEditor: runtime.isVSCode,
    enabled: enableFileReferences && !isStreaming,
  });
  useExternalLinkInteractions({ containerRef });
  const {
    reconcileMarkdownImageResources,
    transportIdentity: imageTransportIdentity,
  } = useMarkdownImageInteractions({ containerRef, effectiveDirectory, onShowPopup });

  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
  const ctx = useDecorateContext(
    currentTheme,
    live,
    effectiveDirectory ? handlePreviewLoopback : undefined,
    DEFAULT_MERMAID_CONTROLS,
    imageTransportIdentity,
    effectiveDirectory,
    Boolean(onShowPopup),
  );
  const cacheKey = `markdown-${part?.id ? `part-${part.id}` : `message-${messageId}`}`;

  useMorphdomMarkdown({
    containerRef,
    text: pacedText,
    streaming: live,
    cacheKey,
    syntaxVars,
    ctx,
    reconcileMarkdownImageResources,
    onRichContentReady: revealRichContent,
  });

  // A streaming turn grows every frame, and an unrevealed container is still
  // showing the placeholder — neither height describes the settled render.
  useMarkdownHeightMemo(
    containerRef,
    markdownHeightCacheKey(content, variant),
    richReady && !live,
  );

  const markdownContent = (
    <div
      aria-busy={!richReady || undefined}
      className={cn('relative break-words w-full min-w-0', className)}
      data-markdown-ready={richReady ? 'true' : 'false'}
      data-markdown-hydration={richReady ? 'ready' : 'pending'}
      ref={containerRef}
    >
      {!richReady && (
        <div
          className={cn(
            markdownContentClassName(variant),
            'pointer-events-none absolute inset-0 overflow-hidden',
          )}
        >
          <MarkdownLoadingPlaceholder content={pacedText} />
        </div>
      )}
      <div
        aria-hidden={!richReady || undefined}
        className={cn(markdownContentClassName(variant), !richReady && 'invisible')}
        data-markdown-content
      />
    </div>
  );

  if (isAnimated) {
    return (
      <FadeInOnReveal key={cacheKey} skipAnimation={skipFadeIn}>
        {markdownContent}
      </FadeInOnReveal>
    );
  }

  return markdownContent;
};

export const MarkdownRenderer = React.memo(MarkdownRendererImpl, (prev, next) => {
  return prev.content === next.content
    && prev.isStreaming === next.isStreaming
    && prev.disableStreamAnimation === next.disableStreamAnimation
    && prev.variant === next.variant
    && prev.isAnimated === next.isAnimated
    && prev.skipFadeIn === next.skipFadeIn
    && prev.className === next.className
    && prev.messageId === next.messageId
    && prev.onShowPopup === next.onShowPopup
    && prev.enableFileReferences === next.enableFileReferences
    && prev.part?.id === next.part?.id;
});

const SimpleMarkdownRendererImpl: React.FC<{
  content: string;
  className?: string;
  variant?: MarkdownVariant;
  disableLinkSafety?: boolean;
  stripFrontmatter?: boolean;
  onShowPopup?: (content: ToolPopupContent) => void;
  mermaidControls?: MermaidControlOptions;
  allowMermaidWheelEvents?: boolean;
  enableFileReferences?: boolean;
}> = ({
  content,
  className,
  variant = 'assistant',
  disableLinkSafety,
  stripFrontmatter = false,
  onShowPopup,
  mermaidControls = DEFAULT_MERMAID_CONTROLS,
  allowMermaidWheelEvents = false,
  enableFileReferences = true,
}) => {
  const { editor, runtime } = useRuntimeAPIs();
  const currentTheme = useCurrentMermaidTheme();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [richReady, revealRichContent] = useRichMarkdownReveal(false);
  const effectiveDirectory = useEffectiveDirectory() ?? '';

  const renderedContent = React.useMemo(
    () => (stripFrontmatter ? stripLeadingFrontmatter(content) : content),
    [content, stripFrontmatter],
  );

  useMermaidInlineInteractions({
    containerRef,
    onShowPopup,
    enableFullscreen: DEFAULT_MERMAID_FULLSCREEN_ENABLED,
    enablePanZoom: mermaidControls.showPanZoomControls,
    allowMermaidWheelEvents,
  });
  useFileReferenceInteractions({
    containerRef,
    effectiveDirectory,
    editor,
    preferRuntimeEditor: runtime.isVSCode,
    enabled: enableFileReferences,
  });
  useExternalLinkInteractions({ containerRef, enabled: !disableLinkSafety });
  const {
    reconcileMarkdownImageResources,
    transportIdentity: imageTransportIdentity,
  } = useMarkdownImageInteractions({ containerRef, effectiveDirectory, onShowPopup });

  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
  const ctx = useDecorateContext(
    currentTheme,
    false,
    undefined,
    mermaidControls,
    imageTransportIdentity,
    effectiveDirectory,
    Boolean(onShowPopup),
  );

  useMorphdomMarkdown({
    containerRef,
    text: renderedContent,
    streaming: false,
    cacheKey: `simple:${variant}`,
    syntaxVars,
    ctx,
    reconcileMarkdownImageResources,
    onRichContentReady: revealRichContent,
  });

  return (
    <div
      aria-busy={!richReady || undefined}
      className={cn('relative break-words w-full min-w-0', className)}
      data-markdown-ready={richReady ? 'true' : 'false'}
      data-markdown-hydration={richReady ? 'ready' : 'pending'}
      ref={containerRef}
    >
      {!richReady && (
        <div
          className={cn(
            markdownContentClassName(variant),
            'pointer-events-none absolute inset-0 overflow-hidden',
          )}
        >
          <MarkdownLoadingPlaceholder content={renderedContent} />
        </div>
      )}
      <div
        aria-hidden={!richReady || undefined}
        className={cn(markdownContentClassName(variant), !richReady && 'invisible')}
        data-markdown-content
      />
    </div>
  );
};

export const SimpleMarkdownRenderer = React.memo(SimpleMarkdownRendererImpl, (prev, next) => {
  const prevMermaidControls = prev.mermaidControls ?? DEFAULT_MERMAID_CONTROLS;
  const nextMermaidControls = next.mermaidControls ?? DEFAULT_MERMAID_CONTROLS;

  return prev.content === next.content
    && prev.variant === next.variant
    && prev.className === next.className
    && prev.disableLinkSafety === next.disableLinkSafety
    && prev.stripFrontmatter === next.stripFrontmatter
    && prev.onShowPopup === next.onShowPopup
    && prevMermaidControls.download === nextMermaidControls.download
    && prevMermaidControls.copy === nextMermaidControls.copy
    && prevMermaidControls.showPanZoomControls === nextMermaidControls.showPanZoomControls
    && prev.allowMermaidWheelEvents === next.allowMermaidWheelEvents
    && prev.enableFileReferences === next.enableFileReferences;
});
