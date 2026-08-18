import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELAY_IMAGE_AUTO_LOAD_MAX_BYTES,
  imageRequiresManualLoadOverRelay,
  isRelayTransport,
  needsRuntimeImageStream,
  resolveImageSource,
} from './imageSource';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const helperSource = readFileSync(join(sourceDirectory, 'imageSource.ts'), 'utf8');
const rendererSource = readFileSync(join(sourceDirectory, 'MarkdownRendererImpl.tsx'), 'utf8');
const decorateSource = readFileSync(join(sourceDirectory, 'markdown/decorate.ts'), 'utf8');
const markdownCoreSource = readFileSync(join(sourceDirectory, 'markdown/markdownCore.ts'), 'utf8');
const stylesSource = readFileSync(join(sourceDirectory, '../../index.css'), 'utf8');
const attachmentSource = readFileSync(join(sourceDirectory, 'FileAttachment.tsx'), 'utf8');
const dialogSource = readFileSync(join(sourceDirectory, 'message/ToolOutputDialog.tsx'), 'utf8');

describe('resolveImageSource', () => {
  test('resolves relative POSIX and Windows paths from the effective directory', () => {
    expect(resolveImageSource('assets/photo.png', '/workspace/project')).toEqual({
      kind: 'runtime-file',
      source: 'assets/photo.png',
      path: '/workspace/project/assets/photo.png',
    });
    expect(resolveImageSource('assets\\photo.png', 'C:\\workspace\\project')).toEqual({
      kind: 'runtime-file',
      source: 'assets\\photo.png',
      path: 'C:/workspace/project/assets/photo.png',
    });
    expect(resolveImageSource('assets/My%20Photo.png', '/workspace/project')).toEqual({
      kind: 'runtime-file',
      source: 'assets/My%20Photo.png',
      path: '/workspace/project/assets/My Photo.png',
    });
  });

  test('normalizes POSIX and Windows file URLs', () => {
    expect(resolveImageSource('file:///tmp/My%20Image.png', '/workspace')).toEqual({
      kind: 'runtime-file',
      source: 'file:///tmp/My%20Image.png',
      path: '/tmp/My Image.png',
    });
    expect(resolveImageSource('file:///C:/Users/demo/image.png', '/workspace')).toEqual({
      kind: 'runtime-file',
      source: 'file:///C:/Users/demo/image.png',
      path: 'C:/Users/demo/image.png',
    });
    expect(resolveImageSource('file://C:/Users/demo/image.png', '/workspace')).toEqual({
      kind: 'runtime-file',
      source: 'file://C:/Users/demo/image.png',
      path: 'C:/Users/demo/image.png',
    });
  });

  test('keeps absolute local paths on the runtime file route', () => {
    expect(resolveImageSource('/var/tmp/image.png', '/workspace')).toEqual({
      kind: 'runtime-file',
      source: '/var/tmp/image.png',
      path: '/var/tmp/image.png',
    });
    expect(resolveImageSource('D:\\images\\image.png', '/workspace')).toEqual({
      kind: 'runtime-file',
      source: 'D:\\images\\image.png',
      path: 'D:/images/image.png',
    });
  });

  test('keeps browser and runtime API sources direct', () => {
    for (const source of [
      'https://example.com/image.png',
      'http://example.com/image.png',
      'data:image/png;base64,AAAA',
      'blob:https://example.com/id',
      '/api/fs/raw?path=image.png',
      '/api?asset=image.png',
    ]) {
      expect(resolveImageSource(source, '/workspace')).toEqual({ kind: 'direct', source });
    }
  });
});

describe('isRelayTransport', () => {
  test('identifies relay transport identities', () => {
    expect(isRelayTransport('direct:url:http://127.0.0.1:4096')).toBe(false);
    expect(isRelayTransport('relay:{"serverId":"srv_123"}')).toBe(true);
  });
});

describe('imageRequiresManualLoadOverRelay', () => {
  test('gates only oversized known sizes on relay transport', () => {
    const relay = 'relay:{"serverId":"srv_123"}';
    const direct = 'direct:url:http://127.0.0.1:4096';

    expect(imageRequiresManualLoadOverRelay(relay, RELAY_IMAGE_AUTO_LOAD_MAX_BYTES)).toBe(false);
    expect(imageRequiresManualLoadOverRelay(relay, RELAY_IMAGE_AUTO_LOAD_MAX_BYTES + 1)).toBe(true);
    expect(imageRequiresManualLoadOverRelay(direct, RELAY_IMAGE_AUTO_LOAD_MAX_BYTES * 20)).toBe(false);
  });

  test('never gates unknown or invalid sizes', () => {
    const relay = 'relay:{"serverId":"srv_123"}';
    expect(imageRequiresManualLoadOverRelay(relay, undefined)).toBe(false);
    expect(imageRequiresManualLoadOverRelay(relay, 0)).toBe(false);
    expect(imageRequiresManualLoadOverRelay(relay, -5)).toBe(false);
    expect(imageRequiresManualLoadOverRelay(relay, Number.NaN)).toBe(false);
    expect(imageRequiresManualLoadOverRelay(relay, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('needsRuntimeImageStream', () => {
  test('streams every runtime-file source, including local Electron file URLs', () => {
    expect(needsRuntimeImageStream(resolveImageSource('file:///tmp/photo.png', '/workspace'))).toBe(true);
    expect(needsRuntimeImageStream(resolveImageSource('/var/tmp/photo.png', '/workspace'))).toBe(true);
    expect(needsRuntimeImageStream(resolveImageSource('https://example.com/a.png', '/workspace'))).toBe(false);
    expect(needsRuntimeImageStream(resolveImageSource('data:image/png;base64,AA', '/workspace'))).toBe(false);
  });
});

describe('image source contracts', () => {
  test('loads local images through runtimeFetch and cleans object URLs on every transport', () => {
    expect(helperSource).toContain("from '@/lib/relay/relay-image-stream'");
    expect(helperSource).toContain('streamRelayImageDisplayUrl');
    expect(helperSource).toContain('releaseRelayImageDisplayUrl');
    expect(helperSource).toContain('return await streamRelayImageDisplayUrl(path, signal)');
    expect(helperSource).toContain('IMAGE_RELAY_RETRY_DELAYS_MS');
    expect(helperSource).toContain('for (const delayMs of IMAGE_RELAY_RETRY_DELAYS_MS)');
    expect(helperSource).toContain("signal.addEventListener('abort'");
    expect(helperSource).toContain('subscribeRuntimeEndpointChanged');
    expect(helperSource).toContain('getRuntimeTransportIdentity');
    expect(helperSource).toContain('needsRuntimeImageStream(resolved)');
    expect(helperSource).toContain('const usesRuntimeFileSource = needsRuntimeImageStream(resolved)');
    expect(helperSource).toContain('controller.abort()');
    expect(helperSource).toContain('releaseRuntimeImageObjectUrl(objectUrl)');
    expect(helperSource).toContain('releaseRuntimeImageObjectUrl(nextObjectUrl)');
  });

  test('streams runtime-file Markdown images on every transport and keeps http(s)/data direct', () => {
    expect(decorateSource).toContain("data-md-link-favicon");
    expect(markdownCoreSource).toContain("DOMPurify.addHook('uponSanitizeAttribute'");
    expect(markdownCoreSource).toContain("node.setAttribute('data-md-image-source', source)");
    expect(markdownCoreSource).toContain('data.keepAttr = false');
    expect(decorateSource).not.toContain('decorateMessageImages');
    expect(rendererSource).toContain('img:not([data-md-link-favicon="true"])');
    expect(rendererSource).not.toContain('if (!isRelayTransport(transportIdentity))');
    expect(rendererSource).toContain('needsRuntimeImageStream(resolved)');
    expect(rendererSource).not.toContain('IntersectionObserver');
    expect(rendererSource).toContain('React.useLayoutEffect(() => {');
    expect(rendererSource).toContain('const activateImage = (image: HTMLImageElement)');
    expect(rendererSource).toContain('if (state && !state.objectUrl)');
    expect(rendererSource).toContain('loadImage(image, state);');
    expect(rendererSource).toContain('openImage(image);');
    // Auto-load from reconcile on first paint/commit, plus click/keyboard retry path.
    expect(rendererSource.match(/loadImage\(image, state\);/g)).toHaveLength(2);
    expect(rendererSource).toContain('state.controller || state.objectUrl');
    // First paint runs the full decorate pass (images included) so the sync
    // layout already matches the async commit's geometry.
    expect(rendererSource).toContain('decorateMarkdown(block, ctx)');
    expect(decorateSource).toContain("image.setAttribute('data-md-image-source', source)");
    expect(decorateSource).toContain("spriteIcon('file-image', 'size-10')");
    expect(decorateSource).toContain("spriteIcon('download', 'size-3')");
    expect(decorateSource).toContain("spriteIcon('loader-4', 'size-3.5 animate-spin motion-reduce:animate-none')");
    expect(decorateSource).toContain("presentation.setAttribute('data-md-image-presentation', 'true')");
    expect(decorateSource).toContain("parent?.matches(MARKDOWN_IMAGE_PRESENTATION_SELECTOR)");
    expect(decorateSource).toContain("visual.setAttribute('data-md-image-placeholder-visual', 'true')");
    expect(decorateSource).toContain("loadingBadge.setAttribute('data-md-image-loading-badge', 'true')");
    expect(stylesSource).toContain("img[data-md-image-state='loaded']");
    expect(stylesSource).toContain("img[data-md-image-state='loading']");
    expect(stylesSource).toContain("[data-md-image-loading-badge='true']");
    expect(decorateSource).toContain('setMarkdownImagePlaceholder(image)');
    expect(decorateSource).toContain('if (!ctx.imagePreviewEnabled)');
    expect(decorateSource).toContain('if (!needsRuntimeImageStream(resolved)) continue');
    expect(decorateSource).not.toContain('isRelayTransport(ctx.imageTransportIdentity)');
    const decorateImagesStart = decorateSource.indexOf('export const decorateMarkdownImages');
    const imageScanStart = decorateSource.indexOf('root.querySelectorAll<HTMLImageElement>(MARKDOWN_IMAGE_SELECTOR)', decorateImagesStart);
    expect(decorateSource.indexOf('if (!ctx.imagePreviewEnabled)', decorateImagesStart)).toBeLessThan(imageScanStart);
    expect(decorateSource).toContain("'focus-visible:outline-[var(--interactive-focus-ring)]'");
    expect(decorateSource).toContain("'rounded-xl'");
    expect(decorateSource).toContain("'border-border/80'");
    const imageHookStart = rendererSource.indexOf('const useMarkdownImageInteractions');
    const imageHookEnd = rendererSource.indexOf('const DEFAULT_MERMAID_CONTROLS', imageHookStart);
    const imageHook = rendererSource.slice(imageHookStart, imageHookEnd);
    expect(imageHook).not.toContain('subscribeRuntimeEndpointChanged');
    expect(imageHook).not.toContain('new MutationObserver');
    expect(imageHook).toContain('transportIdentityRef.current ??= getRuntimeTransportIdentity()');
    expect(imageHook).toContain('const ensureImageState = (image: HTMLImageElement)');
    expect(imageHook).toContain('images.set(image, state)');
    expect(imageHook).toContain('reconcileRef.current = (root)');
    expect(imageHook).toContain('openImageSaveActions');
    expect(imageHook).toContain('createMobileLongPressController');
    const imageReconcileStart = imageHook.indexOf('reconcileRef.current = (root)');
    const imageReconcileEnd = imageHook.indexOf('const activateImage', imageReconcileStart);
    const imageReconcile = imageHook.slice(imageReconcileStart, imageReconcileEnd);
    expect(imageReconcile).toContain('for (const [image, state] of images)');
    expect(imageReconcile).toContain('root.querySelectorAll<HTMLImageElement>(MARKDOWN_IMAGE_SELECTOR)');
    expect(imageReconcile).toContain('const state = ensureImageState(image)');
    expect(imageReconcile).toContain('loadImage(image, state)');
    expect(imageReconcile).toContain('if (state && !state.objectUrl)');
    expect(rendererSource.match(/reconcileMarkdownImageResources\(target\);/g)).toHaveLength(3);
    expect(rendererSource).toContain('const imagesRef = React.useRef(new Map<HTMLImageElement, RelayImageState>())');
    expect(rendererSource).toContain("event.key !== 'Enter' && event.key !== ' '");
    expect(rendererSource).toContain("metadata: { tool: 'image-preview', filename }");
    expect(rendererSource).toContain('image: { url: selectedSource');
    expect(rendererSource).toContain('releaseRuntimeImageObjectUrl(state.objectUrl)');
    expect(rendererSource).toContain('releaseRuntimeImageObjectUrl(objectUrl)');
    expect(rendererSource).toContain('state.controller?.abort()');
  });

  test('keeps virtual image streams alive through a StrictMode effect replay', () => {
    const imageHookStart = rendererSource.indexOf('const useMarkdownImageInteractions');
    const imageHookEnd = rendererSource.indexOf('const DEFAULT_MERMAID_CONTROLS', imageHookStart);
    const imageHook = rendererSource.slice(imageHookStart, imageHookEnd);

    expect(imageHook).toContain('const imagesRef = React.useRef(new Map<HTMLImageElement, RelayImageState>())');
    expect(imageHook).toContain('const deferredImageCleanupTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)');
    expect(imageHook).toContain('clearTimeout(deferredImageCleanupTimerRef.current)');
    expect(imageHook).toContain('reconcileRef.current(container);');
    expect(imageHook).toContain('deferredImageCleanupTimerRef.current = setTimeout(() => {');
    expect(imageHook).toContain('Keep the virtual URL through that replay');
  });

  test('shares resolved display sources while popup payloads retain original URLs', () => {
    expect(attachmentSource).toContain("import { useResolvedImageSource,");
    expect(attachmentSource).toContain('source={file.url}');
    expect(attachmentSource).toContain('url: file.url');
    expect(dialogSource).toContain("import { useResolvedImageSource } from '../imageSource'");
    expect(dialogSource).toContain('src={displayImageSource || undefined}');
  });

  test('keeps immersive image viewer gestures split by mobile and desktop contracts', () => {
    expect(dialogSource).toContain('resolveImageViewerPointerRelease({');
    expect(dialogSource).toContain('onDoubleClick={isMobile ? undefined : handleDoubleClick}');
    expect(dialogSource).toContain("if (event.pointerType !== 'mouse') event.preventDefault();");
    expect(dialogSource).toContain('targetWasCanvas: event.target === event.currentTarget');
    expect(dialogSource).toContain('pointerType: remainingPointer.pointerType');
    expect(dialogSource).not.toContain('lastTapRef');
    expect(dialogSource).not.toContain('chat.toolOutputDialog.image.closeAria');
    expect(dialogSource).not.toContain('chat.toolOutputDialog.image.previewTitle');
  });

  test('protects viewer controls and source resets from canvas gesture side effects', () => {
    const pointerDownStart = dialogSource.indexOf('const handlePointerDown');
    const pointerDownEnd = dialogSource.indexOf('const handlePointerMove', pointerDownStart);
    const pointerDownSource = dialogSource.slice(pointerDownStart, pointerDownEnd);
    expect(pointerDownSource).toContain("if (event.pointerType !== 'mouse') event.preventDefault();");
    expect(pointerDownSource.match(/event\.preventDefault\(\);/g)).toHaveLength(1);
    expect(dialogSource).toContain('onDoubleClick={(event) => event.stopPropagation()}');

    const resetStart = dialogSource.indexOf('React.useEffect(() => {\n        if (pendingFrameRef.current !== null)');
    const resetEnd = dialogSource.indexOf('React.useLayoutEffect(() => {', resetStart);
    const resetSource = dialogSource.slice(resetStart, resetEnd);
    expect(resetSource).toContain('window.cancelAnimationFrame(pendingFrameRef.current)');
    expect(resetSource).toContain('pendingFrameRef.current = null');
    expect(resetSource).toContain('pendingTransformRef.current = null');
    expect(resetSource.indexOf('pendingTransformRef.current = null')).toBeLessThan(resetSource.indexOf("imageRef.current.style.transform = 'translate3d(0, 0, 0) scale(1)'"));
  });

  test('keeps the viewer full-width and traps focus with an invisible close action', () => {
    expect(dialogSource).toContain('className="absolute inset-0 flex items-center justify-center overflow-hidden touch-none [overscroll-behavior:none]"');
    expect(dialogSource).toContain('ref={closeButtonRef}');
    expect(dialogSource).toContain('className="sr-only"');
    expect(dialogSource).toContain("{t('dialog.common.actions.close')}");
    expect(dialogSource).toContain("if (event.key === 'Tab')");
    expect(dialogSource).toContain("if (event.key === 'Escape')");
    expect(dialogSource).toContain('previousFocusRef.current = document.activeElement');
    expect(dialogSource).toContain('previousFocus.focus({ preventScroll: true })');
  });

  test('arms the native trailing-click guard before a mobile tap unmounts the viewer', () => {
    const viewerStart = dialogSource.indexOf('const ImagePreviewDialog');
    const viewerEnd = dialogSource.indexOf('// ── PERF-007', viewerStart);
    const viewerSource = dialogSource.slice(viewerStart, viewerEnd);
    expect(viewerSource).toContain('const consumeViewerClick = useEvent');
    expect(viewerSource).toContain('event.preventDefault()');
    expect(viewerSource).toContain('event.stopPropagation()');
    expect(viewerSource).toContain('onClick={consumeViewerClick}');
    expect(viewerSource).toContain("if (isMobile && gesture.pointerType !== 'mouse')");
    expect(viewerSource).toContain('closeImageViewerAfterMobileTap(point, () => onOpenChange(false))');
    expect(viewerSource).toMatch(/closeImageViewerAfterMobileTap\(point, \(\) => onOpenChange\(false\)\);\s*return;/);
  });

  test('registers mobile back to dismiss fullscreen preview without leaving chat', () => {
    expect(dialogSource).toContain("import { useMobileBackRoute } from '@/mobile/mobileBackNavigation'");
    expect(dialogSource).toContain("id: 'image-preview'");
    expect(dialogSource).toContain('active: popup.open && isMobile');
    expect(dialogSource).toContain("layer: 'overlay'");
    expect(dialogSource).toContain('openImageSaveActions');
    expect(dialogSource).toContain('IMAGE_VIEWER_LONG_PRESS_MS');
    expect(dialogSource).toContain('onContextMenu={handleContextMenu}');
  });
});
